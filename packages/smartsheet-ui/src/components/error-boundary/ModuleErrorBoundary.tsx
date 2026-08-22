import React from "react";

export interface ModuleCrashResult {
	saved: boolean;
}

interface ModuleErrorBoundaryProps {
	children: React.ReactNode;
	moduleName: string;
	onCrash?: (
		error: Error,
		info: { moduleName: string; componentStack?: string },
	) => Promise<ModuleCrashResult>;
	onReload?: () => void;
	className?: string;
}

interface ModuleErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
	componentStack: string;
	saveResult: ModuleCrashResult | null;
	isSaving: boolean;
}

const FALLBACK_TEXT = {
	title: (name: string) => `${name} encountered an error`,
	saving: "Saving your work...",
	saveSuccess: "Your latest changes have been saved.",
	saveFailed:
		"Auto-save failed. Data may revert to the last saved version after reload.",
	reload: "Reload",
};

export class ModuleErrorBoundary extends React.Component<
	ModuleErrorBoundaryProps,
	ModuleErrorBoundaryState
> {
	state: ModuleErrorBoundaryState = {
		hasError: false,
		error: null,
		componentStack: "",
		saveResult: null,
		isSaving: false,
	};

	static getDerivedStateFromError(
		error: Error,
	): Partial<ModuleErrorBoundaryState> {
		return { hasError: true, error, isSaving: true };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo) {
		const { moduleName, onCrash } = this.props;
		const componentStack = info.componentStack ?? "";
		this.setState({ componentStack });

		console.error(
			`[ModuleErrorBoundary:${moduleName}] Module crashed:`,
			error,
			componentStack,
		);

		if (onCrash) {
			onCrash(error, { moduleName, componentStack: componentStack || undefined })
				.then((result) => {
					this.setState({ saveResult: result, isSaving: false });
				})
				.catch(() => {
					this.setState({
						saveResult: { saved: false },
						isSaving: false,
					});
				});
		} else {
			this.setState({ saveResult: null, isSaving: false });
		}
	}

	handleReload = () => {
		this.props.onReload?.();
	};

	render() {
		if (!this.state.hasError) {
			return this.props.children;
		}

		const { moduleName, onReload, className } = this.props;
		const { error, saveResult, isSaving, componentStack } = this.state;
		const isDev =
			typeof process !== "undefined" &&
			process.env?.NODE_ENV === "development";

		return (
			<div
				className={`flex h-full w-full items-center justify-center p-8 ${className ?? ""}`}
			>
				<div className="flex max-w-md flex-col items-center gap-5 text-center">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="40"
						height="40"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="opacity-50"
						style={{ color: "hsl(var(--destructive))" }}
					>
						<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
						<path d="M12 9v4" />
						<path d="M12 17h.01" />
					</svg>

					<div>
						<h2 className="text-subtitle font-semibold text-foreground">
							{FALLBACK_TEXT.title(moduleName)}
						</h2>

						{isSaving && (
							<p className="mt-2 text-body text-muted-foreground">
								{FALLBACK_TEXT.saving}
							</p>
						)}

						{!isSaving && saveResult && (
							<p className={`mt-2 text-body ${saveResult.saved ? "text-muted-foreground" : "text-destructive"}`}>
								{saveResult.saved
									? FALLBACK_TEXT.saveSuccess
									: FALLBACK_TEXT.saveFailed}
							</p>
						)}

						{error && (
							<p className="mx-auto mt-3 max-w-sm truncate text-caption text-muted-foreground/60">
								{error.message}
							</p>
						)}
					</div>

					{!isSaving && onReload && (
						<button
							type="button"
							onClick={this.handleReload}
							className="flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-body font-medium text-foreground hover:bg-muted"
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
							{FALLBACK_TEXT.reload}
						</button>
					)}

					{isDev && componentStack && (
					<details className="mt-2 w-full text-left">
						<summary className="cursor-pointer text-caption text-muted-foreground/60">
							Component stack
						</summary>
						<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-2 text-caption text-muted-foreground">
								{componentStack}
							</pre>
						</details>
					)}
				</div>
			</div>
		);
	}
}
