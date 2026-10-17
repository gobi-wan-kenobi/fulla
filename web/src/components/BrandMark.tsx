// SPDX-License-Identifier: GPL-3.0-or-later
/** Fulla's golden band, filled a little more than half (res/drawable/ic_launcher_foreground.xml). Always gold. */
export function BrandMark({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="24 24 60 60" aria-hidden>
      <defs>
        <clipPath id="fulla-band">
          <path d="M30,54 A24,24 0 1,1 78,54 A24,24 0 1,1 30,54 Z" />
        </clipPath>
      </defs>
      <g clipPath="url(#fulla-band)">
        <path fill="#C9971F" opacity="0.9" d="M26,56 C36,52 44,52 54,56 S72,60 82,56 L82,82 L26,82 Z" />
      </g>
      <path fill="none" stroke="#E9B949" strokeWidth="5" d="M27,54 A27,27 0 1,1 81,54 A27,27 0 1,1 27,54 Z" />
    </svg>
  );
}
