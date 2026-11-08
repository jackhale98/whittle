import type { SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & { strokeWidth?: number | string };

/**
 * Chamfer: the Fillet icon's square with its corner cut straight instead of rounded (lucide
 * geometry and stroke conventions, so it sits with the other command-bar icons).
 */
export function ChamferIcon({ strokeWidth = 2, className, ...rest }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-icon="chamfer"
      aria-hidden="true"
      {...rest}
    >
      <path d="M21 11 13 3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    </svg>
  );
}
