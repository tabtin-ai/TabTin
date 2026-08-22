import React from "react";

interface PanelErrorBoundaryProps {
	children: React.ReactNode;
	name: string;
	displayName?: string;
	onError?: (
		error: Error,
		info: { name: string; componentStack?: string },
	) => void;
	maxRetries?: number;
	className?: string;
}

interface PanelErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
	retryCount: number;
}

const FALLBACK_TEXT = {
	title: (name: string) => `${name} encountered an error`,
	description: "An error occurred in this area. Other features are not affected.",
	retry: "Retry",
	locked: "Multiple retries failed. Please reload.",
};

export class PanelErrorBoundary extends React.Component<
	PanelErrorBoundaryProps,
	PanelErrorBoundaryState
> {
	state: PanelErrorBoundaryState = {
		hasError: false,
		error: null,
		retryCount: 0,
	};

	static getDerivedStateFromError(error: Error): Partial<PanelErrorBoundaryState> {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo) {
		const { name, onError } = this.props;
		console.error(`[PanelErrorBoundary:${name}] Panel crashed:`, error, info.componentStack);
		onError?.(error, {
			name,
			componentStack: info.componentStack ?? undefined,
		});
	}

	handleRetry = () => {
		this.setState((prev) => ({
			hasError: false,
			error: null,
			retryCount: prev.retryCount + 1,
		}));
	};

	render() {
		if (!this.state.hasError) {
			return this.props.children;
		}

		const { name, displayName, maxRetries = 3, className } = this.props;
		const label = displayName || name;
		const isLocked = this.state.retryCount >= maxRetries;
		const isDev = typeof process !== "undefined" && process.env?.NODE_ENV === "development";

		return (
			<div
				className={`flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center ${className ?? ""}`}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="28"
					height="28"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="text-destructive opacity-50"
				>
					<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
					<path d="M12 9v4" />
					<path d="M12 17h.01" />
				</svg>

				<div>
					<h3 className="text-body font-medium text-foreground">
						{FALLBACK_TEXT.title(label)}
					</h3>
					<p className="mt-1 text-caption text-muted-foreground">
						{isLocked ? FALLBACK_TEXT.locked : FALLBACK_TEXT.description}
					</p>
					{this.state.error && (
						<p className="mx-auto mt-2 max-w-md truncate text-caption text-muted-foreground/60">
							{this.state.error.message}
						</p>
					)}
				</div>

				{!isLocked && (
					<button
						type="button"
						onClick={this.handleRetry}
						className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-body font-medium text-foreground hover:bg-muted"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
							<path d="M21 3v5h-5" />
							<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
							<path d="M8 16H3v5" />
						</svg>
						{FALLBACK_TEXT.retry}
					</button>
				)}

				{isDev && this.state.error?.stack && (
					<details className="mt-2 w-full max-w-lg text-left">
						<summary className="cursor-pointer text-caption text-muted-foreground/60">
							Stack trace
						</summary>
						<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 text-caption text-muted-foreground">

							{this.state.error.stack}
						</pre>
					</details>
				)}
			</div>
		);
	}
}
