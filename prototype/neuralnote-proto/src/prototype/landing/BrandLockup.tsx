import brandAppIconUrl from "../../../../../assets/brand/icons/neuralnote-app-icon-128.png";
import brandMarkUrl from "../../../../../assets/brand/marks/neuralnote-mark-128.png";

export const brandName = "NeuralNote";

type BrandSize = "sm" | "md";

const markSize: Record<BrandSize, string> = {
  sm: "size-7",
  md: "size-8",
};

export function BrandMark({
  className = "",
  variant = "mark",
}: {
  className?: string;
  variant?: "mark" | "app-icon";
}) {
  return (
    <img
      src={variant === "app-icon" ? brandAppIconUrl : brandMarkUrl}
      alt=""
      aria-hidden="true"
      data-neuralnote-brand-mark={variant === "mark" ? "true" : undefined}
      data-neuralnote-app-icon={variant === "app-icon" ? "true" : undefined}
      className={`shrink-0 object-contain ${className}`}
    />
  );
}

export function BrandLockup({
  className = "",
  size = "sm",
}: {
  className?: string;
  size?: BrandSize;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <BrandMark className={markSize[size]} />
      <span
        data-neuralnote-wordmark="true"
        className="nn-heading text-[15px] font-medium leading-none tracking-[-0.025em]"
      >
        {brandName}
      </span>
    </span>
  );
}
