const imageTypes = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  dib: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
  jfif: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
}

export function getPreviewType(name) {
  const extension = /\.([a-z0-9]+)$/i.exec(name.trimEnd())?.[1].toLowerCase()
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown', byteLimit: 1024 ** 2 }
  if (Object.hasOwn(imageTypes, extension)) return { kind: 'image', mime: imageTypes[extension], byteLimit: 24 * 1024 ** 2 }
  return null
}
