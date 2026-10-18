import React from "react";

interface SettingsGroupProps {
  title?: string;
  description?: string;
  /** Leading glyph shown next to the title, e.g. a lucide-react icon. */
  icon?: React.ReactNode;
  /** Short status text shown trailing the title, e.g. "Downloaded, 1.5 GB". */
  badge?: string;
  children: React.ReactNode;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  icon,
  badge,
  children,
}) => {
  return (
    <div className="space-y-2">
      {title && (
        <div className="px-4 flex items-baseline justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-xs font-medium text-mid-gray uppercase tracking-wide">
            {icon && (
              <span className="text-logo-primary [&_svg]:w-3.5 [&_svg]:h-3.5">
                {icon}
              </span>
            )}
            {title}
          </h2>
          {badge && (
            <span className="text-xs text-mid-gray normal-case tracking-normal">
              {badge}
            </span>
          )}
        </div>
      )}
      {description && (
        <p className="px-4 -mt-1 text-xs text-mid-gray">{description}</p>
      )}
      <div className="bg-background border border-mid-gray/20 rounded-xl overflow-visible shadow-sm">
        <div className="divide-y divide-mid-gray/20">{children}</div>
      </div>
    </div>
  );
};
