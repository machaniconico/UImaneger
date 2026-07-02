interface Props {
  message: string;
  tone: "loading" | "error";
}

export function PreviewOverlay({ message, tone }: Props) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-white/80 px-4 text-center text-sm"
    >
      <div
        className={`rounded border px-3 py-2 shadow-sm ${
          isError
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-neutral-200 bg-white text-neutral-600"
        }`}
      >
        {message}
      </div>
    </div>
  );
}
