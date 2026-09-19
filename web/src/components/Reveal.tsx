import { motion, type HTMLMotionProps } from 'framer-motion';
import type { ReactNode } from 'react';

export const EASE = [0.22, 1, 0.36, 1] as const;
export const STEP = 0.045;

/** Fades and floats an element in from above; `i` staggers siblings top-down. */
export function reveal(i = 0, base = 0.04, dist = -14) {
  return {
    initial: { opacity: 0, y: dist },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, ease: EASE, delay: base + i * STEP },
  };
}

interface Props extends HTMLMotionProps<'div'> {
  i?: number;
  base?: number;
  dist?: number;
  children?: ReactNode;
}

export default function Reveal({ i = 0, base = 0.04, dist = -14, children, ...rest }: Props) {
  return (
    <motion.div {...reveal(i, base, dist)} {...rest}>
      {children}
    </motion.div>
  );
}

/** Soft drop-in for full-screen modals. */
export const modalMotion = {
  initial: { opacity: 0, y: -28 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -16, transition: { duration: 0.22, ease: EASE } },
  transition: { type: 'spring', stiffness: 320, damping: 34, mass: 0.8 },
} as const;
