import crypto from 'node:crypto';
import { A2A_REMOTE_TASK_ID_PREFIX } from '../../shared/a2aRemote';

/**
 * Deterministic ledger id for a task that crossed hosts: `rt-` + the first 32
 * hex chars of SHA-256(linkId + '\0' + messageId). Both sides compute the same
 * id from the same (linkId, messageId), so a redelivered message lands on the
 * existing task instead of minting a second one. The NUL separator keeps
 * ('ab','c') and ('a','bc') apart. Shape matches `isRemoteTaskId`.
 */
export function remoteTaskId(linkId: string, messageId: string): string {
  const digest = crypto.createHash('sha256').update(`${linkId}\0${messageId}`, 'utf8').digest('hex');
  return A2A_REMOTE_TASK_ID_PREFIX + digest.slice(0, 32);
}
