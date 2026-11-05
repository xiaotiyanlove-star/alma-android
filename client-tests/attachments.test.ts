import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_LIMIT_BYTES, imageRequestPath, looksLikeImage, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, MAX_ATTACHMENTS, buildMessage, checkFile, resolveMediaType, sniffMediaType, uploadRoute } from '../client/attachments.ts'

test('images take the image route, everything else the generic one', () => {
  assert.equal(uploadRoute('image/png'), '/api/attachments/image')
  assert.equal(uploadRoute('IMAGE/JPEG'), '/api/attachments/image')
  assert.equal(uploadRoute('image/webp'), '/api/attachments/image')
  assert.equal(uploadRoute('application/pdf'), '/api/attachments/file')
  assert.equal(uploadRoute(''), '/api/attachments/file')
})

test('a file the desktop would refuse is caught before uploading', () => {
  assert.match(checkFile('', 10, 0)!, /文件名为空/)
  assert.match(checkFile('a.txt', 0, 0)!, /空文件/)
  assert.match(checkFile('big.bin', MAX_ATTACHMENT_BYTES + 1, 0)!, new RegExp(`${MAX_ATTACHMENT_MB} MB`))
  assert.match(checkFile('a.txt', 10, MAX_ATTACHMENTS)!, /6 个附件/)
  assert.equal(checkFile('ok.txt', 1024, 0), null)
})

test('exactly at the limit is allowed', () => {
  assert.equal(checkFile('edge.bin', MAX_ATTACHMENT_BYTES, 0), null)
})

test('the attachment limit stays under the frame the tunnel can actually carry', () => {
  // An upload is one sealed WebSocket message. The relay rejects anything over
  // 32 MiB, so an attachment at that size would fail mid-transfer and be
  // reported as an uncertain mutation rather than a refusal.
  assert.ok(MAX_ATTACHMENT_BYTES < FRAME_LIMIT_BYTES, 'the client must refuse before the relay does')
  // Room for the GCM tag and the JSON header that names the route.
  const headroom = FRAME_LIMIT_BYTES - MAX_ATTACHMENT_BYTES
  assert.ok(headroom >= 1024, `only ${headroom} bytes of headroom`)
})

test('the message carries the returned desktop paths', () => {
  const text = buildMessage('看下这个', [
    { path: '/Users/x/cache/attachment-abc.pdf', name: 'a.pdf', size: 1, renamed: true },
    { path: '/Users/x/cache/attachment-def.png', name: 'b.png', size: 2, renamed: true },
  ])
  assert.match(text, /^看下这个/)
  assert.match(text, /\n\n附件：\n\n- \/Users\/x\/cache\/attachment-abc\.pdf/)
  assert.match(text, /\/Users\/x\/cache\/attachment-def\.png/)
})

test('a file-only message still reads sensibly', () => {
  const text = buildMessage('   ', [{ path: '/tmp/a.bin', name: 'a.bin', size: 1, renamed: false }])
  assert.equal(text.startsWith('附件：'), true)
  assert.equal(text.includes('/tmp/a.bin'), true)
})

test('no files leaves the message untouched', () => {
  assert.equal(buildMessage('hello', []), 'hello')
})

test('the limit survives base64, which the frame uses without binary support', () => {
  // A desktop that does not echo `bin: 1` gets the body base64-encoded inside
  // the JSON frame: four bytes for every three, plus the IV, the tag and the
  // header. At 24 MiB that landed exactly on the relay's limit and every upload
  // to an older desktop failed mid-send, reported as an uncertain mutation.
  const encoded = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
  const overhead = 12 + 16 + 1024
  assert.ok(encoded + overhead < FRAME_LIMIT_BYTES, `base64 makes ${encoded + overhead} bytes, over ${FRAME_LIMIT_BYTES}`)
})

test('image references become the route the desktop serves them from', () => {
  // The desktop reports `/api/…` routes as-is and plain absolute paths for a
  // file on its own disk; the official client rewrites the latter into the
  // file route, and so must this one.
  assert.equal(imageRequestPath('/api/herdr/image/pic.png'), '/api/herdr/image/pic.png')
  assert.equal(imageRequestPath('/api/herdr/file?path=%2Fx'), '/api/herdr/file?path=%2Fx')
  assert.equal(imageRequestPath('/Users/me/shot.png'), '/api/herdr/file?path=%2FUsers%2Fme%2Fshot.png')
  assert.equal(imageRequestPath('~/shot.png'), '/api/herdr/file?path=~%2Fshot.png')
  // Anything that would make the desktop reach somewhere of the message's
  // choosing is refused rather than rewritten.
  assert.throws(() => imageRequestPath('https://example.com/x.png'))
  assert.throws(() => imageRequestPath('//example.com/x.png'))
  assert.throws(() => imageRequestPath('relative/x.png'))
})

const bytes = (...values: number[]) => new Uint8Array(values)

test('a PNG is recognised from its bytes when the picker sends no type', () => {
  // Android's document picker returns an empty type for ordinary pictures.
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)
  assert.equal(sniffMediaType(png), 'image/png')
  assert.equal(resolveMediaType({ name: 'Screenshot.png', type: '' }, png), 'image/png')
  assert.equal(resolveMediaType({ name: 'shot', type: '' }, png), 'image/png')
})

test('a generic type does not override what the bytes say', () => {
  const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)
  assert.equal(resolveMediaType({ name: 'photo.jpg', type: 'application/octet-stream' }, jpeg), 'image/jpeg')
  assert.equal(uploadRoute(resolveMediaType({ name: 'photo.jpg', type: 'application/octet-stream' }, jpeg)), '/api/attachments/image')
})

test('other formats are recognised too', () => {
  assert.equal(sniffMediaType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif')
  assert.equal(sniffMediaType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), 'image/webp')
  assert.equal(sniffMediaType(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66)), 'image/avif')
  assert.equal(sniffMediaType(bytes(0x25, 0x50, 0x44, 0x46)), 'application/pdf')
  assert.equal(sniffMediaType(bytes(1, 2, 3, 4)), null)
})

test('a name is the last resort when the bytes are not a known format', () => {
  assert.equal(resolveMediaType({ name: 'notes.md', type: '' }, bytes(1, 2)), 'text/markdown')
  assert.equal(resolveMediaType({ name: 'thing.unknown', type: '' }, bytes(1, 2)), 'application/octet-stream')
})

test('pictures are detected by extension as well as by declared type', () => {
  assert.equal(looksLikeImage({ name: 'a.png', type: '' }), true)
  assert.equal(looksLikeImage({ name: 'a', type: 'image/jpeg' }), true)
  assert.equal(looksLikeImage({ name: 'a.txt', type: 'text/plain' }), false)
})
