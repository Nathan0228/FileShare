import Icon from './Icon.jsx'
import { getFileType } from './fileTypes.js'

export default function FileIcon({ filename }) {
  const { icon, tone, label } = getFileType(filename)

  return (
    <span role="img" aria-label={label} title={label} className={`grid size-10 shrink-0 place-items-center rounded-lg ${tone}`}>
      <Icon name={icon} size={21} />
    </span>
  )
}
