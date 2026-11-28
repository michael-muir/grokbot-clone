// A bot's avatar (its shape in its color, with a face) and the picker for shape and color.
import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape } from "../../../../../server/src/types.ts";
import { botColor, botShape } from "../bot-colors.ts";
import { EYE, eyeRects, FACES, type Part, STROKE, VIEW } from "./avatar-faces.ts";
import { liven } from "./face-director.ts";

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
 * Decorative: wherever it appears, the bot's name is next to it or on the control around it. With `botId` the face
 * is alive (it faces you and watches the pointer over it, sways and reacts to runs; see face-director.ts); without it,
 * it's still, as in the shape picker.
 */
export function Avatar({
  avatar,
  size,
  botId,
}: {
  avatar: { shape: string; color: string };
  size?: "small" | "large" | "xl";
  botId?: string;
}) {
  const shape = botShape(avatar.shape);
  const face = FACES[shape];
  const ref = useRef<HTMLSpanElement>(null);
  // Before paint: the tilt it's drawn with comes from CSS variables `liven` sets, so it mustn't first show upright.
  useLayoutEffect(() => {
    const el = ref.current;
    return el && botId !== undefined ? liven(el, botId, face) : undefined;
  }, [botId, face]);
  return (
    <span
      ref={ref}
      className={size ? `avatar ${size}` : "avatar"}
      data-shape={shape}
      data-bot-color={botColor(avatar.color)}
      data-live={botId === undefined ? undefined : ""}
      aria-hidden="true"
    >
      <svg className="avatar-face" viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true">
        <g className="avatar-tilt" transform={`rotate(${face.tilt} ${face.pivot[0]} ${face.pivot[1]})`}>
          <g className="avatar-body" strokeWidth={STROKE}>
            {face.parts.map(drawPart)}
          </g>
          <g className="avatar-eyes">
            {eyeRects(face).map((eye) => (
              <g key={eye.x} transform={`rotate(${EYE.slant} ${eye.x + eye.width / 2} ${eye.y + eye.height / 2})`}>
                <rect className="avatar-eye" {...eye} rx={eye.width / 2} />
              </g>
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
