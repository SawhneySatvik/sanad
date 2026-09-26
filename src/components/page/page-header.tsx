import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "cn";

export interface PageHeaderProps extends HTMLAttributes<HTMLHeadingElement> {
  title: string;
  description?: string;
  /** A right-aligned slot — a button, a menu, a rename control. */
  actions?: ReactNode;
  /** Applies to the OUTER row, not the heading itself — a caller styling the heading uses className on the heading via the spread HTMLAttributes instead. */
  containerClassName?: string;
}

/**
 * One page-header shape for every top-level screen, so a title's own font size and position stop
 * drifting screen to screen. Forwards its ref (and any HTML heading attribute, e.g. tabIndex) to the
 * real <h1> — compare's own view focuses its heading on route entry, and needs the exact DOM node
 * this component renders to do that.
 */
export const PageHeader = forwardRef<HTMLHeadingElement, PageHeaderProps>(function PageHeader(
  { title, description, actions, containerClassName, className, ...headingProps },
  ref,
) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-2", containerClassName)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 ref={ref} className={cn("font-display text-2xl font-medium text-foreground outline-none", className)} {...headingProps}>
          {title}
        </h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
});
