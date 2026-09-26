"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

const subscribeNever = () => () => {};

// next-themes only knows the resolved theme after hydration (it reads localStorage/matchMedia
// client-side) — rendering that before hydration would mismatch the server's markup and flash.
// useSyncExternalStore's server/client snapshot split reports "not yet mounted" through hydration
// and "mounted" after, with no setState-in-effect render cascade.
function useMounted(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

/** The light/dark/system switch, driven entirely by next-themes' own hook. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    // Non-modal, as ItemMenu: a modal Radix menu aria-hides the page behind it without taking its
    // controls out of the Tab order.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Toggle theme">
          {/* CSS-only swap, driven by the .dark class next-themes' own pre-paint script sets on
              <html> before hydration — a JS-computed icon would either flash Sun-then-Moon (a
              client-only mount gate) or need next-themes' post-hydration resolvedTheme, which
              isn't known during SSR at all. Neither icon carries its own name: the button's
              static aria-label already names the action, and stays correct in every state. */}
          <Sun aria-hidden="true" className="dark:hidden" />
          <Moon aria-hidden="true" className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* A real radio group — aria-checked is only valid on role="menuitemradio", which
            DropdownMenuRadioItem renders; a plain DropdownMenuItem with aria-checked bolted on is
            not a role that attribute is valid on. */}
        <DropdownMenuRadioGroup value={mounted ? theme : undefined} onValueChange={setTheme}>
          {OPTIONS.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden="true" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
