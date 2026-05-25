import { forwardRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export type ButtonVariant = 'default' | 'primary' | 'primary-ghost' | 'ghost' | 'subtle';
export type ButtonSize = 'default' | 'compact' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function joinClassNames(...classNames: Array<string | false | null | undefined>) {
  return classNames.filter(Boolean).join(' ') || undefined;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, type = 'button', variant = 'default', size = 'default', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClassNames(
        variant !== 'default' && variant,
        size === 'compact' && 'compact',
        size === 'icon' && 'icon-btn',
        className,
      )}
      {...props}
    />
  );
});

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  return <input ref={ref} {...props} />;
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(props, ref) {
  return <textarea ref={ref} {...props} />;
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  return <select ref={ref} {...props} />;
});

export interface VisuallyHiddenProps {
  children: ReactNode;
  className?: string;
}

export function VisuallyHidden({ children, className }: VisuallyHiddenProps) {
  return <span className={joinClassNames('sr-only', className)}>{children}</span>;
}
