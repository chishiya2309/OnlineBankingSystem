import React from "react";

const paths = {
  plans: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9v12h5v-7h4v7h5V9" /></>,
  portfolio: <><path d="M12 3v9h9" /><path d="M20.5 15a9 9 0 1 1-11.5-11.5" /></>,
  admin: <><path d="m12 3 8 4v6c0 4-5 7-8 8-3-1-8-4-8-8V7l8-4Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  close: <><path d="m6 6 12 12M6 18 18 6" /></>,
  wallet: <><path d="M20 8V5H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V7" /><path d="M21 12h-6v5h6M17 14.5h.01" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  link: <><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" /></>,
};

export type IconName = keyof typeof paths;

export const Icon: React.FC<{ name: IconName; size?: number; className?: string }> = ({ name, size = 20, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
    {paths[name]}
  </svg>
);
