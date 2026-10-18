import React from "react";
import SelectComponent, { components } from "react-select";
import CreatableSelect from "react-select/creatable";
import type {
  ActionMeta,
  DropdownIndicatorProps,
  OptionProps,
  Props as ReactSelectProps,
  SingleValue,
  SingleValueProps,
  StylesConfig,
} from "react-select";
import { ChevronDown } from "lucide-react";

export type SelectOption = {
  value: string;
  label: string;
  /** Short context line shown under the label, e.g. "Fast, balanced accuracy". */
  sublabel?: string;
  /** Leading glyph shown before the label, e.g. a lucide-react icon. */
  icon?: React.ReactNode;
  isDisabled?: boolean;
};

type BaseProps = {
  value: string | null;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  isClearable?: boolean;
  onChange: (value: string | null, action: ActionMeta<SelectOption>) => void;
  onBlur?: () => void;
  className?: string;
  formatCreateLabel?: (input: string) => string;
};

type CreatableProps = {
  isCreatable: true;
  onCreateOption: (value: string) => void;
};

type NonCreatableProps = {
  isCreatable?: false;
  onCreateOption?: never;
};

export type SelectProps = BaseProps & (CreatableProps | NonCreatableProps);

const baseBackground =
  "color-mix(in srgb, var(--color-mid-gray) 10%, transparent)";
const hoverBackground =
  "color-mix(in srgb, var(--color-logo-primary) 12%, transparent)";
const focusBackground =
  "color-mix(in srgb, var(--color-logo-primary) 20%, transparent)";
const neutralBorder =
  "color-mix(in srgb, var(--color-mid-gray) 80%, transparent)";

const selectStyles: StylesConfig<SelectOption, false> = {
  control: (base, state) => ({
    ...base,
    minHeight: 40,
    borderRadius: 11,
    borderColor: state.isFocused ? "var(--color-logo-primary)" : neutralBorder,
    boxShadow: state.isFocused ? "0 0 0 1px var(--color-logo-primary)" : "none",
    backgroundColor: state.isFocused ? focusBackground : baseBackground,
    fontSize: "0.875rem",
    color: "var(--color-text)",
    transition: "all 150ms ease",
    ":hover": {
      borderColor: "var(--color-logo-primary)",
      backgroundColor: hoverBackground,
    },
  }),
  valueContainer: (base) => ({
    ...base,
    paddingInline: 10,
    paddingBlock: 6,
  }),
  input: (base) => ({
    ...base,
    color: "var(--color-text)",
  }),
  singleValue: (base) => ({
    ...base,
    color: "var(--color-text)",
    display: "flex",
    alignItems: "center",
    gap: 8,
  }),
  dropdownIndicator: (base, state) => ({
    ...base,
    color: state.isFocused
      ? "var(--color-logo-primary)"
      : "color-mix(in srgb, var(--color-mid-gray) 80%, transparent)",
    transition: "transform 120ms ease, color 120ms ease",
    transform: state.isFocused ? "rotate(180deg)" : "rotate(0deg)",
    ":hover": {
      color: "var(--color-logo-primary)",
    },
  }),
  clearIndicator: (base) => ({
    ...base,
    color: "color-mix(in srgb, var(--color-mid-gray) 80%, transparent)",
    ":hover": {
      color: "var(--color-logo-primary)",
    },
  }),
  menu: (provided) => ({
    ...provided,
    zIndex: 30,
    borderRadius: 13,
    overflow: "hidden",
    backgroundColor: "var(--color-background)",
    color: "var(--color-text)",
    border:
      "1px solid color-mix(in srgb, var(--color-mid-gray) 30%, transparent)",
    boxShadow:
      "0 12px 28px rgba(15, 15, 15, 0.16), 0 2px 6px rgba(15, 15, 15, 0.08)",
  }),
  menuList: (base) => ({
    ...base,
    padding: 6,
  }),
  option: (base, state) => ({
    ...base,
    borderRadius: 8,
    backgroundColor: state.isSelected
      ? focusBackground
      : state.isFocused
        ? hoverBackground
        : "transparent",
    color: state.isSelected ? "var(--color-logo-primary)" : "var(--color-text)",
    fontWeight: state.isSelected ? 600 : 400,
    cursor: state.isDisabled ? "not-allowed" : base.cursor,
    opacity: state.isDisabled ? 0.5 : 1,
  }),
  placeholder: (base) => ({
    ...base,
    color: "color-mix(in srgb, var(--color-mid-gray) 65%, transparent)",
  }),
};

const SelectIcon: React.FC<{ icon: React.ReactNode }> = ({ icon }) => (
  <span className="flex-shrink-0 text-mid-gray [&_svg]:w-3.5 [&_svg]:h-3.5">
    {icon}
  </span>
);

const Option: React.FC<OptionProps<SelectOption, false>> = (props) => {
  const { icon, label, sublabel } = props.data;
  return (
    <components.Option {...props}>
      <span className="flex items-center gap-2">
        {icon && <SelectIcon icon={icon} />}
        <span>
          <span className="block">{label}</span>
          {sublabel && (
            <span className="block text-xs text-mid-gray font-normal">
              {sublabel}
            </span>
          )}
        </span>
      </span>
    </components.Option>
  );
};

const SingleValue: React.FC<SingleValueProps<SelectOption, false>> = (
  props,
) => {
  const { icon, label } = props.data;
  return (
    <components.SingleValue {...props}>
      <span className="flex items-center gap-2">
        {icon && <SelectIcon icon={icon} />}
        {label}
      </span>
    </components.SingleValue>
  );
};

const DropdownIndicator: React.FC<
  DropdownIndicatorProps<SelectOption, false>
> = (props) => (
  <components.DropdownIndicator {...props}>
    <ChevronDown className="w-4 h-4" />
  </components.DropdownIndicator>
);

export const Select: React.FC<SelectProps> = React.memo(
  ({
    value,
    options,
    placeholder,
    disabled,
    isLoading,
    isClearable = true,
    onChange,
    onBlur,
    className = "",
    isCreatable,
    formatCreateLabel,
    onCreateOption,
  }) => {
    const selectValue = React.useMemo(() => {
      if (!value) return null;
      const existing = options.find((option) => option.value === value);
      if (existing) return existing;
      return { value, label: value, isDisabled: false };
    }, [value, options]);

    const handleChange = (
      option: SingleValue<SelectOption>,
      action: ActionMeta<SelectOption>,
    ) => {
      onChange(option?.value ?? null, action);
    };

    const sharedProps: Partial<ReactSelectProps<SelectOption, false>> = {
      className,
      classNamePrefix: "app-select",
      value: selectValue,
      options,
      onChange: handleChange,
      placeholder,
      isDisabled: disabled,
      isLoading,
      onBlur,
      isClearable,
      styles: selectStyles,
      components: { Option, SingleValue, DropdownIndicator },
    };

    if (isCreatable) {
      return (
        <CreatableSelect<SelectOption, false>
          {...sharedProps}
          onCreateOption={onCreateOption}
          formatCreateLabel={formatCreateLabel}
        />
      );
    }

    return <SelectComponent<SelectOption, false> {...sharedProps} />;
  },
);

Select.displayName = "Select";
