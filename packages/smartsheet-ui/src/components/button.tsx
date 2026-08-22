import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../utils/cn"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-interactive text-body font-medium ring-offset-background transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85 active:bg-primary/95",
        soft: "bg-primary/10 text-primary-text hover:bg-primary/15 active:bg-primary/20 dark:bg-primary/15 dark:hover:bg-primary/20 dark:active:bg-primary/25",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/85 active:bg-destructive/95",
        outline:
          "bg-muted text-foreground hover:bg-muted/70 active:bg-background",
        secondary:
          "bg-muted text-foreground hover:bg-muted/70 active:bg-background",
        ghost: "text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-4",
        sm: "h-7 px-3 text-body",
        lg: "h-9 px-5 text-body",
        /** 与 Input（h-10）、表单主操作对齐 */
        form: "h-10 px-4 text-body",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
