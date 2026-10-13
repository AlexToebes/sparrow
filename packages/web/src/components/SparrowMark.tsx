/** The Sparrow mark (a sparrow perched on a drive), drawn in currentColor so it follows the theme. Decorative. */
export function SparrowMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(256 256) scale(.94) translate(-257 -245)">
        <g fill="currentColor" stroke="currentColor" strokeLinejoin="round">
          <path
            d="M310 162 C326 144 326 120 334 100 L408 138 C424 182 416 228 390 266 C366 304 326 344 262 344 L204 330 L78 422 L64 408 L184 294 C204 270 220 252 238 226 C260 198 288 184 310 162 Z"
            strokeWidth="10"
          />
          <circle cx="374" cy="108" r="46" stroke="none" />
          <path d="M402 76 L458 102 L402 134 Z" strokeWidth="12" />
          <path d="M290 336 L284 384 M342 308 L350 384" strokeWidth="21" fill="none" />
        </g>
        <path
          fill="currentColor"
          fillRule="evenodd"
          transform="translate(0 -9)"
          d="M212 376 H424 a20 20 0 0 1 20 20 V420 a20 20 0 0 1 -20 20 H212 a20 20 0 0 1 -20 -20 V396 a20 20 0 0 1 20 -20 Z M236 396 h100 a8 8 0 0 1 0 16 h-96 a8 8 0 0 1 0 -16 Z M404 404 a8 8 0 1 0 0.01 0 Z"
        />
      </g>
    </svg>
  );
}
