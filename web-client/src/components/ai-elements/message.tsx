"use client"

import type { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant" | "system"
}

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group flex w-full max-w-[95%] flex-col gap-2",
        from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
        className,
      )}
      {...props}
    />
  )
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export function MessageContent({ children, className, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
        "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
        "group-[.is-assistant]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type MessageMetadataProps = HTMLAttributes<HTMLDivElement>

export function MessageMetadata({ className, children, ...props }: MessageMetadataProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5",
        className,
      )}
      data-slot="message-metadata"
      {...props}
    >
      {children}
    </div>
  )
}

export type MessageMetadataItemProps = HTMLAttributes<HTMLSpanElement>

export function MessageMetadataItem({ className, ...props }: MessageMetadataItemProps) {
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1 whitespace-nowrap", className)}
      data-slot="message-metadata-item"
      {...props}
    />
  )
}
