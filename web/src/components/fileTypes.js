const generic = Object.freeze({ icon: 'file', tone: 'bg-slate-100 text-slate-600', label: '文件' })

const groups = [
  ['file-pdf', 'bg-red-50 text-red-700', 'PDF 文档', 'pdf'],
  ['file-doc', 'bg-blue-50 text-blue-700', '文档', 'doc docx docm odt rtf txt md markdown rst tex pages epub'],
  ['file-sheet', 'bg-emerald-50 text-emerald-700', '表格', 'xls xlsx xlsm xlsb ods csv tsv numbers'],
  ['file-slides', 'bg-orange-50 text-orange-700', '演示文稿', 'ppt pptx pptm pps ppsx odp key'],
  ['file-image', 'bg-violet-50 text-violet-700', '图片', 'jpg jpeg jfif png apng gif bmp dib webp svg ico avif heic heif tiff tif dng raw psd'],
  ['file-video', 'bg-rose-50 text-rose-700', '视频', 'mp4 m4v mov mkv webm avi wmv mpg mpeg mts m2ts flv 3gp ogv'],
  ['file-audio', 'bg-pink-50 text-pink-700', '音频', 'mp3 wav flac ogg oga opus aac m4a aif aiff wma ape mid midi caf mka'],
  ['file-archive', 'bg-amber-50 text-amber-800', '压缩包', 'zip rar 7z tar gz gzip bz bz2 bzip2 xz z zst lz lz4 tgz tbz tbz2 txz tzst cab iso jar war ear'],
  ['file-code', 'bg-cyan-50 text-cyan-800', '源代码', 'js jsx mjs cjs ts tsx cts html htm css scss sass less vue svelte py go rs rb php java kt kts swift c h cc cpp hpp cs sh bash zsh fish lua pl dart vb gradle cmake'],
  ['file-executable', 'bg-slate-200 text-slate-800', '可执行文件', 'exe msi msp dmg pkg app appimage apk aab deb rpm bin run com bat cmd ps1'],
  ['file-data', 'bg-indigo-50 text-indigo-700', '数据文件', 'json jsonl ndjson xml yaml yml toml ini conf config sql db sqlite sqlite3 parquet avro dump'],
  ['file-font', 'bg-teal-50 text-teal-700', '字体', 'ttf otf woff woff2 ttc eot'],
]

const typesByExtension = new Map()
for (const [icon, tone, label, extensions] of groups) {
  const type = Object.freeze({ icon, tone, label })
  for (const extension of extensions.split(' ')) typesByExtension.set(extension, type)
}

export function getFileType(filename) {
  if (typeof filename !== 'string') return generic
  const name = filename.trimEnd().toLowerCase()
  const index = name.lastIndexOf('.')
  if (index <= 0) return generic

  // The compression suffix identifies compound archives such as .tar.gz and .tar.zst.
  return typesByExtension.get(name.slice(index + 1)) ?? generic
}
