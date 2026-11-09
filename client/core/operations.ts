/**
 * Stateless operation helpers kept outside the controller state machine.
 *
 * Mutation retry and uncertainty remain owned by Transport and Controller;
 * these helpers only encode the terminal protocol's key names and input.
 */

export const TERMINAL_KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
  Enter: 'enter',
  Escape: 'esc',
  'C-c': 'ctrl+c',
})

/** Converts display-level key names into the protocol's canonical names. */
export function terminalKeys(keys: readonly string[]): string[] {
  return keys.map((key) => TERMINAL_KEY_NAMES[key]!)
}

export function validTerminalKeys(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.length <= 20 && keys.every((key) => Object.hasOwn(TERMINAL_KEY_NAMES, key))
}

/** Bracketed paste lets multiline and Unicode terminal input arrive intact. */
export function bracketedTerminalText(text: string): string {
  return `\u001b[200~${text}\u001b[201~`
}

/** Menu answer keys, shared by the in-app prompt and notification action. */
export function answerKeys(optionNumber: number, cursor: number, target: number, multiSelect: boolean, moves: (from: number, to: number) => string[] | null, unable = '无法确定光标位置'): string[] {
  const keys: string[] = []
  if (cursor >= 0 && cursor !== target) {
    const move = moves(cursor, target)
    if (!move) throw new Error(unable)
    keys.push(...move)
  }
  if (multiSelect) keys.push(' ')
  else if (cursor >= 0 && cursor !== target) keys.push('enter')
  else keys.push(String(optionNumber))
  return keys
}

export function protocolKeys(keys: readonly string[]): string[] {
  return keys.map((key) => key === ' ' ? 'space' : key)
}
