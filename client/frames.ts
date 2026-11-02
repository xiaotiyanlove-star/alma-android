/**
 * Inner-frame encoding for the E2E tunnel.
 *
 * The relay carries one encrypted blob per WebSocket message, and the plaintext
 * inside it is normally JSON. Frames that embed a large binary payload (an
 * upload body, an `hchunk` slice of a response, a `wmsg` string) do not need to
 * pay base64 + JSON escaping for it. When both peers set `bin: 1` during the
 * handshake we switch those frames to:
 *
 *   [0x00][u32 BE header length][JSON header][payload]
 *
 * The header is the original frame with its payload field removed and `$` set
 * to the field name the payload belongs to. A leading NUL is impossible in a
 * valid JSON document, so a decoder can tell the two forms apart from the first
 * byte, and a peer that never negotiated binary still reads the JSON form.
 *
 * This layout must stay byte-compatible with the desktop's `encodeInnerFrame`;
 * it is a wire format, not an internal detail.
 */
import { base64url, fromBase64url } from './crypto'

/** First byte of every binary inner frame. Valid JSON never starts with NUL. */
export const MARKER = 0

export const BINARY_FRAMES_FIELD = 'bin'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Bytes pass through untouched; other views and buffers are adopted by reference. */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}

/**
 * Encodes one inner frame. Frames without an eligible payload stay JSON even
 * when `binary` is set, so the switch only costs what it saves.
 */
export function encodeInnerFrame(
  frame: Record<string, any>,
  binary: boolean,
): Uint8Array {
  const bytes = asBytes(frame.b)
  if (binary) {
    let field: string | null = null
    let payload: Uint8Array | null = null
    if (bytes) {
      field = 'b'
      payload = bytes
    } else if (frame.t === 'wmsg' && typeof frame.s === 'string') {
      field = 's'
      payload = encoder.encode(frame.s)
    }
    if (field && payload) {
      const header: Record<string, any> = { ...frame, $: field }
      delete header[field]
      const head = encoder.encode(JSON.stringify(header))
      const output = new Uint8Array(5 + head.length + payload.length)
      output[0] = MARKER
      new DataView(output.buffer).setUint32(1, head.length)
      output.set(head, 5)
      output.set(payload, 5 + head.length)
      return output
    }
  }
  if (bytes) {
    return encoder.encode(JSON.stringify({ ...frame, b: base64url(bytes) }))
  }
  return encoder.encode(JSON.stringify(frame))
}

/**
 * Decodes one inner frame. Base64 payloads from a peer that did not negotiate
 * binary are normalised to `Uint8Array` here, so callers never have to branch on
 * which form arrived.
 */
export function decodeInnerFrame(plaintext: Uint8Array): Record<string, any> {
  if (plaintext.length > 0 && plaintext[0] === MARKER) {
    if (plaintext.length < 5) throw new Error('E2E frame header truncated')
    const view = new DataView(
      plaintext.buffer,
      plaintext.byteOffset,
      plaintext.byteLength,
    )
    const headLength = view.getUint32(1)
    if (5 + headLength > plaintext.length) {
      throw new Error('E2E frame header truncated')
    }
    const frame = JSON.parse(
      decoder.decode(plaintext.subarray(5, 5 + headLength)),
    ) as Record<string, any>
    const field = frame.$
    delete frame.$
    const payload = plaintext.slice(5 + headLength)
    if (field === 's') frame.s = decoder.decode(payload)
    else frame.b = payload
    return frame
  }
  const frame = JSON.parse(decoder.decode(plaintext)) as Record<string, any>
  if (typeof frame.b === 'string') frame.b = fromBase64url(frame.b)
  return frame
}
