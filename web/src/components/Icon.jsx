export default function Icon({ name, size = 20, className = '' }) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <use href={`${import.meta.env.BASE_URL}assets/svg/icons.svg#${name}`} />
    </svg>
  )
}
