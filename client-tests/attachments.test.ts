import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_LIMIT_BYTES, imageRequestPath, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, MAX_ATTACHMENTS, buildMessage, checkFile, uploadRoute } from '../client/attachments.ts'

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
