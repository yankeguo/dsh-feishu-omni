import { describe, expect, it } from 'vitest'
import {
  AttachmentFailure, FEISHU_FILE_MAX_BYTES, collectingStream, concatBytes, feishuFileType,
  formatBytes, imageMediaType, mediaTypeExtension, readAllBounded, unsupportedImageFormat,
} from '../src/attachments.ts'
import { GIF_BYTES, HEIC_BYTES, JPEG_BYTES, PNG_BYTES, collect } from './helpers.ts'

describe('attachment format sniffing', () => {
  it('recognizes the four image formats both DSH and Feishu accept', () => {
    expect(imageMediaType(PNG_BYTES)).toBe('image/png')
    expect(imageMediaType(JPEG_BYTES)).toBe('image/jpeg')
    expect(imageMediaType(GIF_BYTES)).toBe('image/gif')
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])
    expect(imageMediaType(webp)).toBe('image/webp')
    expect(mediaTypeExtension('image/png')).toBe('png')
    expect(mediaTypeExtension('image/jpeg')).toBe('jpeg')
    expect(mediaTypeExtension('image/webp')).toBe('webp')
    expect(mediaTypeExtension('image/gif')).toBe('gif')
  })

  it('names recognized unsupported containers so the sender gets a specific notice', () => {
    expect(imageMediaType(HEIC_BYTES)).toBeUndefined()
    expect(unsupportedImageFormat(HEIC_BYTES)).toBe('heic')
    expect(unsupportedImageFormat(Buffer.from('BM' + '\0'.repeat(30)))).toBe('bmp')
    expect(unsupportedImageFormat(Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0]))).toBe('tiff')
    expect(unsupportedImageFormat(Buffer.from('MM\u0000*' + '\0'.repeat(30)))).toBe('tiff')
    expect(unsupportedImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg')
    expect(unsupportedImageFormat(Buffer.alloc(32))).toBeUndefined()
  })

  it('rejects short or empty heads without throwing', () => {
    expect(imageMediaType(new Uint8Array())).toBeUndefined()
    expect(imageMediaType(new Uint8Array([0x89]))).toBeUndefined()
    expect(unsupportedImageFormat(new Uint8Array())).toBeUndefined()
  })
})

describe('Feishu file type mapping', () => {
  it('maps documented extensions and falls back to stream', () => {
    // Audio/video must be uploaded as stream so they pair with msg_type=file;
    // Feishu rejects file_type=opus/mp4 on a file message (230055).
    expect(feishuFileType('a.opus')).toBe('stream')
    expect(feishuFileType('clip.MP4')).toBe('stream')
    expect(feishuFileType('clip.mov')).toBe('stream')
    expect(feishuFileType('报告.pdf')).toBe('pdf')
    expect(feishuFileType('doc.docx')).toBe('doc')
    expect(feishuFileType('sheet.xlsx')).toBe('xls')
    expect(feishuFileType('deck.pptx')).toBe('ppt')
    expect(feishuFileType('archive.zip')).toBe('stream')
    expect(feishuFileType('no-extension')).toBe('stream')
  })

  it('formats byte counts for degradation notices', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB')
  })
})

describe('bounded stream helpers', () => {
  async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const value of values) yield value
  }

  it('reads a whole bounded stream and rejects oversize input', async () => {
    const bytes = await readAllBounded(chunks(new Uint8Array([1, 2]), new Uint8Array([3])), 10, 'image')
    expect([...bytes]).toEqual([1, 2, 3])
    await expect(readAllBounded(chunks(new Uint8Array(6), new Uint8Array(6)), 10, 'image'))
      .rejects.toMatchObject({ name: 'AttachmentFailure', reason: 'too-large' })
  })

  it('forwards every chunk, enforces the hard cap, and keeps a bounded copy', async () => {
    const source = chunks(new Uint8Array([1, 2]), new Uint8Array([3, 4]))
    const stream = collectingStream(source, 10, 4, 'file')
    const forwarded = await collect(stream.data)
    expect([...forwarded]).toEqual([1, 2, 3, 4])
    expect(stream.total()).toBe(4)
    expect(stream.collected() && [...stream.collected()!]).toEqual([1, 2, 3, 4])
  })

  it('drops the mirror copy once the stream proves larger than the copy bound', async () => {
    const source = chunks(new Uint8Array(3), new Uint8Array(3))
    const stream = collectingStream(source, 10, 4, 'file')
    await collect(stream.data)
    expect(stream.total()).toBe(6)
    expect(stream.collected()).toBeUndefined()
  })

  it('throws AttachmentFailure when the hard cap is crossed mid-stream', async () => {
    const stream = collectingStream(chunks(new Uint8Array(7), new Uint8Array(7)), 10, 10, 'file')
    await expect(collect(stream.data)).rejects.toBeInstanceOf(AttachmentFailure)
  })

  it('exposes the documented platform bounds', () => {
    expect(FEISHU_FILE_MAX_BYTES).toBe(30 * 1024 * 1024)
    expect(concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])], 3)).toEqual(new Uint8Array([1, 2, 3]))
  })
})
