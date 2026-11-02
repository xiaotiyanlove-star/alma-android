import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BINARY_FRAMES_FIELD, MARKER, decodeInnerFrame, encodeInnerFrame } from '../client/frames.ts'
import { base64url, createKeyPair, deriveSessionKeys, fromBase64url, openBytes, sealBytes } from '../client/crypto.ts'

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: number[]) => new TextDecoder().decode(new Uint8Array(value))

function split(frame: Uint8Array) {
  const headLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1)
  return {
    marker: frame[0],
    header: JSON.parse(text([...frame.subarray(5, 5 + headLength)])),
    payload: frame.subarray(5 + headLength),
  }
}

test('binary form is marker, big-endian header length, JSON header, raw payload', () => {
  const frame = encodeInnerFrame({ t: 'hreq', id: 'a1', method: 'POST', b: bytes(1, 2, 3) }, true)
  const { marker, header, payload } = split(frame)
  assert.equal(marker, MARKER)
  assert.deepEqual(header, { t: 'hreq', id: 'a1', method: 'POST', $: 'b' })
  assert.deepEqual([...payload], [1, 2, 3])
  // 5-byte prefix + header + payload, nothing else.
  assert.equal(frame.length, 5 + new TextEncoder().encode(JSON.stringify(header)).length + 3)
})

test('a wmsg string payload becomes the s field, and only for wmsg', () => {
  const message = encodeInnerFrame({ t: 'wmsg', id: 'w1', s: '{"type":"items"}' }, true)
  const { header, payload } = split(message)
  assert.equal(header.$, 's')
  assert.deepEqual(header, { t: 'wmsg', id: 'w1', $: 's' })
  assert.equal(text([...payload]), '{"type":"items"}')

  // A non-wmsg frame keeps its s as an ordinary JSON field.
  const other = encodeInnerFrame({ t: 'wopen', id: 'w1', s: 'kept' }, true)
  assert.equal(other[0], 0x7b, 'stays JSON')
  assert.equal(JSON.parse(text([...other])).s, 'kept')
})

test('frames without a payload stay JSON even when binary is negotiated', () => {
  const frame = encodeInnerFrame({ t: 'hres', id: 'x', status: 200 }, true)
  assert.equal(frame[0], 0x7b)
  assert.deepEqual(JSON.parse(text([...frame])), { t: 'hres', id: 'x', status: 200 })
})

test('round-trips both forms back to the same object', () => {
  const payload = new Uint8Array(1024).map((_, index) => index % 251)
  const cases = [
    { t: 'hreq', id: 'a', b: payload },
    { t: 'hchunk', id: 'a', b: bytes(0, 0, 0, 255) },
    { t: 'wmsg', id: 'w', s: 'unicode ✓ 中文 {' },
    { t: 'hend', id: 'a' },
  ]
  for (const frame of cases) {
    for (const binary of [true, false]) {
      const decoded = decodeInnerFrame(encodeInnerFrame(frame, binary))
      assert.deepEqual(decoded, frame, `binary=${binary} t=${frame.t}`)
      if (frame.b) assert.ok(decoded.b instanceof Uint8Array, 'payload always bytes after decode')
    }
  }
})

test('a zero-length payload survives the binary form', () => {
  const decoded = decodeInnerFrame(encodeInnerFrame({ t: 'hreq', id: 'z', b: new Uint8Array(0) }, true))
  assert.equal(decoded.id, 'z')
  assert.equal((decoded.b as Uint8Array).length, 0)
})

test('the JSON fallback uses base64url and decodes to bytes, not a string', () => {
  const payload = bytes(0xfb, 0xff, 0x00, 0x41)
  const wire = encodeInnerFrame({ t: 'hreq', id: 'j', b: payload }, false)
  const parsed = JSON.parse(text([...wire]))
  assert.equal(typeof parsed.b, 'string')
  assert.equal(parsed.b, base64url(payload))
  assert.deepEqual([...decodeInnerFrame(wire).b], [...payload])
})

test('header length is read as big-endian at offset 1', () => {
  const frame = encodeInnerFrame({ t: 'hreq', b: bytes(9) }, true)
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  assert.equal(view.getUint32(1), frame.length - 5 - 1)
})

test('malformed binary headers are rejected instead of silently misparsed', () => {
  assert.throws(() => decodeInnerFrame(bytes(MARKER)), /truncated/)
  assert.throws(() => decodeInnerFrame(bytes(MARKER, 0, 0, 0)), /truncated/)
  // Header length claims more bytes than the frame holds.
  assert.throws(() => decodeInnerFrame(bytes(MARKER, 0, 0, 1, 0, 0x7b)), /truncated/)
})

test('binary frames seal and open through the same AEAD stream', async () => {
  const code = base64url(new Uint8Array(32).fill(3))
  const initiator = await createKeyPair()
  const responder = await createKeyPair()
  const initiatorNonce = new Uint8Array(16).fill(1)
  const responderNonce = new Uint8Array(16).fill(2)
  const keys = await deriveSessionKeys({
    connectCode: code,
    myPrivateKey: initiator.privateKey,
    peerPublic: responder.publicKey,
    initiatorPublic: initiator.publicKey,
    responderPublic: responder.publicKey,
    initiatorNonce,
    responderNonce,
  })
  const frame = { t: 'hchunk', id: 'c', b: new Uint8Array([1, 2, 3, 4]) }
  const sealed = await sealBytes(keys.c2s, 7n, encodeInnerFrame(frame, true))
  assert.deepEqual(decodeInnerFrame(await openBytes(keys.c2s, sealed)), frame)
  // The marker is inside the ciphertext, so the outer bytes never expose it.
  assert.deepEqual([...sealed.subarray(0, 4)], [0, 0, 0, 0], 'outer prefix is the nonce')
})

test('the negotiation field name matches the desktop', () => {
  assert.equal(BINARY_FRAMES_FIELD, 'bin')
  assert.equal(MARKER, 0)
})

// Byte-for-byte vectors derived by reading Alma 0.4.378's `encodeInnerFrame`:
//   field = "b" when the frame carries bytes, else "s" for a wmsg string;
//   header = {...frame, $: field} minus the payload field;
//   layout = [0x00][u32 BE header length][header][payload].
// Key order follows the source object, so `$` lands last.
test('matches the 0.4.378 writer byte for byte', () => {
  const header = '{"t":"hreq","id":"abc","method":"POST","$":"b"}'
  const head = new TextEncoder().encode(header)
  const frame = encodeInnerFrame({ t: 'hreq', id: 'abc', method: 'POST', b: bytes(1, 2, 3) }, true)
  const expected = new Uint8Array(5 + head.length + 3)
  new DataView(expected.buffer).setUint32(1, head.length)
  expected.set(head, 5)
  expected.set([1, 2, 3], 5 + head.length)
  assert.deepEqual([...frame], [...expected])

  const message = '{"type":"items"}'
  const messageHead = new TextEncoder().encode('{"t":"wmsg","id":"w1","$":"s"}')
  const event = encodeInnerFrame({ t: 'wmsg', id: 'w1', s: message }, true)
  const expectedEvent = new Uint8Array(5 + messageHead.length + message.length)
  new DataView(expectedEvent.buffer).setUint32(1, messageHead.length)
  expectedEvent.set(messageHead, 5)
  expectedEvent.set(new TextEncoder().encode(message), 5 + messageHead.length)
  assert.deepEqual([...event], [...expectedEvent])
})

test('reads a frame produced by the 0.4.378 writer', () => {
  const header = '{"t":"hchunk","id":"c","$":"b"}'
  const head = new TextEncoder().encode(header)
  const wire = new Uint8Array(5 + head.length + 4)
  new DataView(wire.buffer).setUint32(1, head.length)
  wire.set(head, 5)
  wire.set([0xde, 0xad, 0xbe, 0xef], 5 + head.length)
  const frame = decodeInnerFrame(wire)
  assert.deepEqual(frame.t, 'hchunk')
  assert.deepEqual(frame.id, 'c')
  assert.deepEqual([...frame.b], [0xde, 0xad, 0xbe, 0xef])
  assert.equal('$' in frame, false, 'the marker field is consumed')
})
