import React from 'react';

interface HeaderProps {
  title: string;
  onBack?: () => void;
  rightAction?: React.ReactNode;
  icon?: string;
}

export const Header: React.FC<HeaderProps> = ({ title, onBack, rightAction, icon }) => {
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between bg-background-light/90 dark:bg-background-dark/90 backdrop-blur-md pt-8 pb-4 px-4 border-b border-gray-200 dark:border-white/10 transition-colors duration-300">
      <div className="flex size-10 items-center justify-start">
        {onBack ? (
          <button
            onClick={onBack}
            className="rounded-full p-2 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
          >
            <span className="text-3xl text-slate-800 dark:text-white">←</span>
          </button>
        ) : icon ? (
          <span className="text-2xl">{icon === 'satellite_alt' ? '🛰️' : icon}</span>
        ) : null}
      </div>

      <h1 className="flex-1 text-center text-lg font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
        {title}
      </h1>

      <div className="flex size-10 items-center justify-end">
        {rightAction}
      </div>
    </header>
  );
};