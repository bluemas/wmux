//! Experimental ANSI replay. Delivery has a separate explicit opt-in gate.
//! Grid/cursor/style restoration is separate from partial input-tail handling.
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use std::fmt::Write;

fn color(out: &mut String, value: Color, foreground: bool) {
    let base = if foreground { 38 } else { 48 };
    match value {
        Color::Spec(rgb) => {
            let _ = write!(out, ";{base};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
        Color::Indexed(index) => {
            let _ = write!(out, ";{base};5;{index}");
        }
        Color::Named(NamedColor::Foreground | NamedColor::Background) => {}
        Color::Named(value) => {
            let index = value as u32;
            if index < 8 {
                let _ = write!(out, ";{}", (if foreground { 30 } else { 40 }) + index);
            } else if index < 16 {
                let _ = write!(out, ";{}", (if foreground { 90 } else { 100 }) + index - 8);
            }
        }
    }
}

fn style(cell: &Cell) -> String {
    let mut out = String::from("\x1b[0");
    for (flag, code) in [
        (Flags::BOLD, 1),
        (Flags::DIM, 2),
        (Flags::ITALIC, 3),
        (Flags::BLINK, 5),
        (Flags::INVERSE, 7),
        (Flags::HIDDEN, 8),
        (Flags::STRIKEOUT, 9),
    ] {
        if cell.flags.contains(flag) {
            let _ = write!(out, ";{code}");
        }
    }
    let underline = if cell.flags.contains(Flags::DOUBLE_UNDERLINE) {
        Some(2)
    } else if cell.flags.contains(Flags::UNDERCURL) {
        Some(3)
    } else if cell.flags.contains(Flags::DOTTED_UNDERLINE) {
        Some(4)
    } else if cell.flags.contains(Flags::DASHED_UNDERLINE) {
        Some(5)
    } else if cell.flags.contains(Flags::UNDERLINE) {
        Some(1)
    } else {
        None
    };
    if let Some(kind) = underline {
        let _ = write!(out, ";4:{kind}");
    }
    color(&mut out, cell.fg, true);
    color(&mut out, cell.bg, false);
    if let Some(value) = cell.underline_color() {
        match value {
            Color::Spec(rgb) => {
                let _ = write!(out, ";58:2::{}:{}:{}", rgb.r, rgb.g, rgb.b);
            }
            Color::Indexed(index) => {
                let _ = write!(out, ";58:5:{index}");
            }
            Color::Named(_) => {}
        }
    }
    out.push('m');
    out
}

fn glyph(out: &mut String, cell: &Cell) {
    out.push(cell.c);
    if let Some(chars) = cell.zerowidth() {
        out.extend(chars);
    }
}

fn cursor(out: &mut String, grid: &Grid<Cell>) {
    let point = grid.cursor.point;
    let mut col = point.column.0;
    if grid.cursor.input_needs_wrap
        && grid[point.line][Column(col)]
            .flags
            .contains(Flags::WIDE_CHAR_SPACER)
    {
        col = col.saturating_sub(1);
    }
    let _ = write!(out, "\x1b[{};{}H", point.line.0 + 1, col + 1);
    // CUP clears wrap-pending. Repaint the edge cell to restore that state.
    if grid.cursor.input_needs_wrap {
        let cell = &grid[point.line][Column(col)];
        out.push_str(&style(cell));
        glyph(out, cell);
    }
    out.push_str(&style(&grid.cursor.template));
}

fn screen(out: &mut String, grid: &Grid<Cell>) {
    let mut previous_style = String::new();
    for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
        let line = &grid[Line(y)];
        for x in 0..grid.columns() {
            let cell = &line[Column(x)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let next_style = style(cell);
            if next_style != previous_style {
                out.push_str(&next_style);
                previous_style = next_style;
            }
            glyph(out, cell);
        }
        if y < grid.screen_lines() as i32 - 1
            && !line[grid.last_column()].flags.contains(Flags::WRAPLINE)
        {
            // Clear rendition before scrolling; otherwise a colored blank
            // template can paint extra cells beyond the serialized content.
            out.push_str("\x1b[0m\r\n");
            previous_style.clear();
        }
    }
    cursor(out, grid);
}

pub fn serialize(term: &Term<VoidListener>) -> Result<String, &'static str> {
    // xterm can retain half a wide glyph when clipping the cursor paragraph.
    // Printing that glyph would wrap instead. Refuse instead of corrupting it.
    for grid in [term.grid(), term.inactive_grid()] {
        for y in -(grid.history_size() as i32)..grid.screen_lines() as i32 {
            if grid[Line(y)][grid.last_column()]
                .flags
                .contains(Flags::WIDE_CHAR)
            {
                return Err("unsupported-wide-edge: clipped fullwidth glyph requires raw replay");
            }
        }
    }
    let mut out = String::from("\x1b[0m\x1b[?6l\x1b[?7h\x1b[4l\x1b[H");
    let modes = term.mode();
    if modes.contains(TermMode::ALT_SCREEN) {
        screen(&mut out, term.inactive_grid());
        out.push_str("\x1b[?1049h\x1b[0m\x1b[H");
    }
    screen(&mut out, term.grid());
    for (mode, code) in [
        (TermMode::APP_CURSOR, 1),
        (TermMode::ORIGIN, 6),
        (TermMode::FOCUS_IN_OUT, 1004),
        (TermMode::SGR_MOUSE, 1006),
        (TermMode::BRACKETED_PASTE, 2004),
    ] {
        if modes.contains(mode) {
            let _ = write!(out, "\x1b[?{code}h");
        }
    }
    if modes.contains(TermMode::INSERT) {
        out.push_str("\x1b[4h");
    }
    if modes.contains(TermMode::APP_KEYPAD) {
        out.push_str("\x1b=");
    }
    if !modes.contains(TermMode::LINE_WRAP) {
        out.push_str("\x1b[?7l");
    }
    if modes.contains(TermMode::MOUSE_MOTION) {
        out.push_str("\x1b[?1003h");
    } else if modes.contains(TermMode::MOUSE_DRAG) {
        out.push_str("\x1b[?1002h");
    } else if modes.contains(TermMode::MOUSE_REPORT_CLICK) {
        out.push_str("\x1b[?1000h");
    }
    out.push_str(if modes.contains(TermMode::SHOW_CURSOR) {
        "\x1b[?25h"
    } else {
        "\x1b[?25l"
    });
    Ok(out)
}
