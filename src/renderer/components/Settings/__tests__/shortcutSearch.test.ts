import { describe, it, expect } from 'vitest';
import { foldShortcutText, matchesShortcutQuery } from '../shortcutSearch';

describe('foldShortcutText', () => {
  it('spells macOS modifier symbols and their word aliases the same way', () => {
    expect(foldShortcutText('⌘+⇧+K')).toBe('cmdshiftk');
    expect(foldShortcutText('command shift k')).toBe('cmdshiftk');
    expect(foldShortcutText('⌥⌃P')).toBe('altctrlp');
    expect(foldShortcutText('Option Control p')).toBe('altctrlp');
    expect(foldShortcutText('opt+ctrl+p')).toBe('altctrlp');
  });
});

describe('matchesShortcutQuery', () => {
  it('finds macOS symbol combos from modifier names', () => {
    expect(matchesShortcutQuery('cmd k', 'Command palette', '⌘+K')).toBe(true);
    expect(matchesShortcutQuery('Command K', 'Command palette', '⌘+K')).toBe(true);
    expect(matchesShortcutQuery('alt', 'Previous workspace', '⌥+ArrowUp')).toBe(true);
    expect(matchesShortcutQuery('option arrowup', 'Previous workspace', '⌥+ArrowUp')).toBe(true);
    expect(matchesShortcutQuery('shift', 'Split down', '⌘+⇧+D')).toBe(true);
    expect(matchesShortcutQuery('ctrl', 'Bookmark', '⌃+M')).toBe(true);
    expect(matchesShortcutQuery('control m', 'Bookmark', 'Ctrl+M')).toBe(true);
  });

  it('still matches plain text, symbols typed directly and partial words', () => {
    expect(matchesShortcutQuery('ctrl n', 'New workspace', 'Ctrl+N')).toBe(true);
    expect(matchesShortcutQuery('ctr', 'New workspace', 'Ctrl+N')).toBe(true);
    expect(matchesShortcutQuery('⌘k', 'Command palette', '⌘+K')).toBe(true);
    expect(matchesShortcutQuery('palet', 'Command palette', '⌘+K')).toBe(true);
    expect(matchesShortcutQuery('', 'Anything', 'Ctrl+N')).toBe(true);
  });

  it('folds modifier names typed without a space or "+"', () => {
    expect(matchesShortcutQuery('optionk', 'Some action', '⌥+K')).toBe(true);
    expect(matchesShortcutQuery('commandk', 'Command palette', '⌘+K')).toBe(true);
    expect(matchesShortcutQuery('controlk', 'Kill line', '⌃+K')).toBe(true);
    expect(matchesShortcutQuery('cmdshiftd', 'Split down', '⌘+⇧+D')).toBe(true);
    expect(matchesShortcutQuery('optk', 'Some action', '⌥+K')).toBe(true);
  });

  it('does not match a different modifier', () => {
    expect(matchesShortcutQuery('alt k', 'Command palette', '⌘+K')).toBe(false);
    expect(matchesShortcutQuery('cmd k', 'Kill line', 'Ctrl+K')).toBe(false);
  });
});
