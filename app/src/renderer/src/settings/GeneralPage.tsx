// Settings › General: appearance and typing, and the one system option that needs a restart.
import type { AppSettings, ThemeSetting } from "../../../shared/settings.ts";
import { Row, Section, Select, Switch } from "./controls.tsx";

const THEMES = [
  { value: "system", label: "Follow System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies readonly { value: ThemeSetting; label: string }[];

export function GeneralPage({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange(patch: Partial<AppSettings>): void;
}) {
  const sendKey = navigator.platform.startsWith("Mac") ? "⌘+Enter" : "Ctrl+Enter";
  return (
    <>
      <Section title="Appearance">
        <Row label="Theme" htmlFor="setting-theme">
          <Select
            id="setting-theme"
            value={settings.theme}
            options={THEMES}
            onChange={(theme) => onChange({ theme })}
          />
        </Row>
        <Row label="Check spelling while typing" htmlFor="setting-spellcheck">
          <Switch
            id="setting-spellcheck"
            checked={settings.spellcheck}
            onChange={(spellcheck) => onChange({ spellcheck })}
          />
        </Row>
        <Row
          label={`Send with ${sendKey}`}
          description={`Press ${sendKey} to send your message. Enter starts a new line.`}
          htmlFor="setting-send"
        >
          <Switch
            id="setting-send"
            checked={settings.sendWithCtrlEnter}
            onChange={(sendWithCtrlEnter) => onChange({ sendWithCtrlEnter })}
          />
        </Row>
      </Section>
      <Section title="System">
        <Row label="Use hardware acceleration" description="Applies after restarting the app." htmlFor="setting-gpu">
          <Switch
            id="setting-gpu"
            checked={settings.hardwareAcceleration}
            onChange={(hardwareAcceleration) => onChange({ hardwareAcceleration })}
          />
        </Row>
      </Section>
    </>
  );
}
