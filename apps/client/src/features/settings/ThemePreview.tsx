import type { Theme } from "../../ui/theme";

export function ThemePreview({ theme }: { theme: Theme }) {
  const modes = theme === "system" ? (["light", "dark"] as const) : [theme];

  return (
    <span className="settings-theme-preview" data-mode={theme} aria-hidden="true">
      {modes.map((mode) => (
        <span className="settings-theme-mini" data-theme-preview={mode} key={mode}>
          <span className="settings-theme-mini-rail">
            <i />
            <i />
            <i />
          </span>
          <span className="settings-theme-mini-page">
            <b />
            <i />
            <i />
            <i />
          </span>
        </span>
      ))}
    </span>
  );
}
