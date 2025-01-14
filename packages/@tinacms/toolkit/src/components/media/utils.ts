const supportedFileTypes = [
  'text/*',
  'application/pdf',
  'application/octet-stream',
  'application/json',
  'application/ld+json',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/*',
]
export const DEFAULT_MEDIA_UPLOAD_TYPES = supportedFileTypes.join(',')

export const dropzoneAcceptFromString = (str: string) => {
  return Object.assign(
    {},
    ...(str || DEFAULT_MEDIA_UPLOAD_TYPES).split(',').map((x) => ({ [x]: [] }))
  )
}

export const isImage = (filename: string): boolean => {
  // http://stackoverflow.com/questions/10473185/regex-javascript-image-file-extension
  return /\.(gif|jpg|jpeg|tiff|png|svg|webp)$/i.test(filename)
}
