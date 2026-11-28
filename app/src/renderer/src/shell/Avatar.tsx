// A bot's avatar (its shape in its color, with a face) and the picker for shape and color.
import { type ReactNode, useId } from "react";
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape } from "../../../../../server/src/types.ts";
import { botColor, botShape } from "../bot-colors.ts";
import { eyeRects, FACES, type Part, STROKE, VIEW } from "./avatar-faces.ts";

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

function drawPart(part: Part, key: number): ReactNode {
  switch (part.kind) {
    case "polygon":
      return <polygon key={key} points={part.points.map((p) => p.join(",")).join(" ")} />;
    case "circle":
      return <circle key={key} cx={part.cx} cy={part.cy} r={part.r} />;
    case "rect":
      return <rect key={key} x={part.x} y={part.y} width={part.width} height={part.height} rx={part.rx} />;
  }
}

/**
 * Decorative: wherever it appears, the bot's name is next to it or on the control around it. The eyes are their
 * own elements (`.avatar-eye`) so they can blink and glance (#44).
 */
export function Avatar({
  avatar,
  size,
}: {
  avatar: { shape: string; color: string };
  size?: "small" | "large" | "xl";
}) {
  const shape = botShape(avatar.shape);
  const face = FACES[shape];
  return (
    <span
      className={size ? `avatar ${size}` : "avatar"}
      data-shape={shape}
      data-bot-color={botColor(avatar.color)}
      aria-hidden="true"
    >
      <svg className="avatar-face" viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true">
        <g transform={`rotate(${face.tilt} ${face.pivot[0]} ${face.pivot[1]})`}>
          <g className="avatar-body" strokeWidth={STROKE}>
            {face.parts.map(drawPart)}
          </g>
          <g className="avatar-eyes">
            {eyeRects(face).map((eye) => (
              <rect key={eye.x} className="avatar-eye" {...eye} rx={eye.width / 2} />
            ))}
          </g>
        </g>
      </svg>
    </span>
  );
}

/** The shape and color choices, as two radio groups. Each pick is reported at once. */
export function AvatarPicker({
  shape,
  color,
  onChange,
}: {
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
        render={(s) => <Avatar avatar={{ shape: s, color }} />}
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
