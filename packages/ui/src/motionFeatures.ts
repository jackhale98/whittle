/**
 * Motion's animation engine, loaded lazily (see `ShellRoot`): the shell paints with its resting
 * styles first and gains springs a moment later, keeping ~25 KB gzip off the initial route.
 */
export { domAnimation as default } from 'motion/react';
