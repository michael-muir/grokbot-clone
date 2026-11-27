// A bot's avatar (its shape in its color, with its initial on top) and the picker for shape and color.
import { type ReactNode, useId } from "react";
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape } from "../../../../../server/src/types.ts";
import { botColor, botShape, initial } from "../bot-colors.ts";

/**
 * Each shape on a 32-unit square. Drawn filled and stroked in the bot's color with round joins, which softens the
 * corners; everything stays inside 1.5 units of the edge so the stroke isn't cut off.
 */
export const SHAPE_DRAWINGS: Record<AvatarShape, ReactNode> = {
  circle: <circle cx="16" cy="16" r="13" />,
  square: <rect x="4" y="4" width="24" height="24" rx="4" />,
  diamond: <polygon points="16,3.5 28.5,16 16,28.5 3.5,16" />,
  hexagon: <polygon points="16,3 27.26,9.5 27.26,22.5 16,29 4.74,22.5 4.74,9.5" />,
  pentagon: <polygon points="16,3.5 28.84,12.83 23.94,27.92 8.06,27.92 3.16,12.83" />,
  octagon: (
    <polygon points="10.83,3.53 21.17,3.53 28.47,10.83 28.47,21.17 21.17,28.47 10.83,28.47 3.53,21.17 3.53,10.83" />
  ),
  triangle: <polygon points="16,4 28.5,27.5 3.5,27.5" />,
  star: (
    <polygon points="16,3 21,10.12 29.31,12.67 24.08,19.63 24.23,28.33 16,25.5 7.77,28.33 7.92,19.63 2.69,12.67 11,10.12" />
  ),
  flower: (
    <>
      <circle cx="16" cy="9.5" r="6.5" />
      <circle cx="22.5" cy="16" r="6.5" />
      <circle cx="16" cy="22.5" r="6.5" />
      <circle cx="9.5" cy="16" r="6.5" />
      <circle cx="16" cy="16" r="8" />
    </>
  ),
  cloud: (
    <>
      <circle cx="10.5" cy="18.5" r="6.5" />
      <circle cx="21.5" cy="18.5" r="6.5" />
      <circle cx="16" cy="13" r="8.5" />
      <rect x="4" y="17" width="24" height="8.5" rx="4.25" />
    </>
  ),
  shield: <path d="M16 3.5 L27.5 7.5 V15 C27.5 21.5 22.5 26.5 16 28.5 C9.5 26.5 4.5 21.5 4.5 15 V7.5 Z" />,
  drop: <path d="M16 3.5 C19 7.5 26 13 26 18.5 A10 10 0 0 1 6 18.5 C6 13 13 7.5 16 3.5 Z" />,
};

/** How shapes and colors are named to screen readers. */
export const SHAPE_NAMES: Record<AvatarShape, string> = {
  circle: "Circle",
  square: "Square",
  diamond: "Diamond",
  hexagon: "Hexagon",
  pentagon: "Pentagon",
  octagon: "Octagon",
  triangle: "Triangle",
  star: "Star",
  flower: "Flower",
  cloud: "Cloud",
  shield: "Shield",
  drop: "Drop",
};

export function Avatar({
  name,
  avatar,
  size,
  showInitial = true,
}: {
  name: string;
  avatar: { shape: string; color: string };
  size?: "small" | "large" | "xl";
  /** The picker's swatches show the shape alone. */
  showInitial?: boolean;
}) {
  const shape = botShape(avatar.shape);
  return (
    <span
      className={size ? `avatar ${size}` : "avatar"}
      data-shape={shape}
      data-bot-color={botColor(avatar.color)}
      aria-hidden="true"
    >
      <svg className="avatar-shape" viewBox="0 0 32 32" aria-hidden="true">
        {SHAPE_DRAWINGS[shape]}
      </svg>
      {showInitial && <span className="avatar-letter">{initial(name)}</span>}
    </span>
  );
}

/** The shape and color choices, as two radio groups. Each pick is reported at once. */
export function AvatarPicker({
  name,
  shape,
  color,
  onChange,
}: {
  name: string;
  shape: AvatarShape;
  color: AvatarColor;
  onChange(avatar: { shape: AvatarShape; color: AvatarColor }): void;
}) {
  return (
    <div className="avatar-picker">
      <RadioGroup
        label="Shape"
        className="shape-grid"
        options={AVATAR_SHAPES}
        value={shape}
        onPick={(s) => onChange({ shape: s, color })}
        optionLabel={(s) => SHAPE_NAMES[s]}
        render={(s) => <Avatar name={name} avatar={{ shape: s, color }} showInitial={false} />}
      />
      <RadioGroup
        label="Color"
        className="color-grid"
        options={AVATAR_COLORS}
        value={color}
        onPick={(c) => onChange({ shape, color: c })}
        optionLabel={(c) => c[0]?.toUpperCase() + c.slice(1)}
        render={(c) => <span className="color-swatch" data-bot-color={c} aria-hidden="true" />}
      />
    </div>
  );
}

/** Native radios, so Tab reaches the chosen option and the arrow keys move and choose, as people expect. */
function RadioGroup<T extends string>({
  label,
  className,
  options,
  value,
  onPick,
  optionLabel,
  render,
}: {
  label: string;
  className: string;
  options: readonly T[];
  value: T;
  onPick(option: T): void;
  optionLabel(option: T): string;
  render(option: T): ReactNode;
}) {
  const name = useId();
  return (
    <fieldset className={className}>
      <legend className="visually-hidden">{label}</legend>
      {options.map((option) => (
        <label key={option} className="picker-option" title={optionLabel(option)}>
          <input
            type="radio"
            className="visually-hidden"
            name={name}
            value={option}
            checked={option === value}
            aria-label={optionLabel(option)}
            onChange={() => onPick(option)}
          />
          {render(option)}
        </label>
      ))}
    </fieldset>
  );
}
