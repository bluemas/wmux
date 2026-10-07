import crypto from 'node:crypto';
import { A2A_REMOTE_TASK_ID_PREFIX } from '../../shared/a2aRemote';

/**
 * Deterministic ledger id for a task that crossed hosts: `rt-` + the first 32
 * hex chars of SHA-256(linkId + '\0' + messageId). Both sides compute the same
 * id from the same (linkId, messageId), so a redelivered message lands on the
 * existing task instead of minting a second one. Shape matches `isRemoteTaskId`.
 *
 * The NUL separator only keeps ('ab','c') and ('a','bc') apart if neither part
 * can contain NUL itself — otherwise ('a\0b','c') and ('a','b\0c') hash the
 * same bytes. So both parts are validated here, at the one place the id is
 * derived: non-empty, at most 256 chars, no NUL. Throws on a violation.
 */
export function remoteTaskId(linkId: string, messageId: string): string {
  assertIdPart('linkId', linkId);
  assertIdPart('messageId', messageId);
  const digest = crypto.createHash('sha256').update(`${linkId}\0${messageId}`, 'utf8').digest('hex');
  return A2A_REMOTE_TASK_ID_PREFIX + digest.slice(0, 32);
}

const MAX_ID_PART_LENGTH = 256;

function assertIdPart(name: string, v: string): void {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ID_PART_LENGTH || v.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string of at most ${MAX_ID_PART_LENGTH} chars without NUL`);
  }
}
