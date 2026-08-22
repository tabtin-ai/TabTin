// Overlay Container (multi-tab scoping)
export {
  OverlayContainerContext,
  OverlayContainerProvider,
  useOverlayContainer,
  type OverlayContainerProviderProps,
  type OverlayContainerContextValue,
} from './components/overlay-container-context'

// UI Components
export { Button } from './components/button'
export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogScrollBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogPortal,
  DialogOverlay
} from './components/dialog'
export { AgentCard } from './components/agent-card'
export { TableSelector } from './components/table-selector'
export { LoadingSpinner } from './components/loading-spinner'
export { Skeleton } from './components/skeleton'
export { Badge, type BadgeProps } from './components/badge'
export { Input } from './components/input'
export { Label } from './components/label'
export { Separator } from './components/separator'
export { Menu, type MenuItem, type MenuProps } from './components/menu/dropdown-menu'
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
} from './components/dropdown-menu'
export { TestDialog, type TestDialogProps } from './components/test-dialog'
export { SimpleImportDialog, type SimpleImportDialogProps } from './components/simple-import-dialog'
export { WorkingImportDialog, type WorkingImportDialogProps } from './components/working-import-dialog'

// Organization Components
export {
  OrganizationSelector,
  CreateOrganizationDialog,
  type OrganizationSelectorProps,
  type CreateOrganizationDialogProps,
  type Organization,
  type OrganizationMember,
  type OrganizationRole,
  type OrganizationSettings,
  type CreateOrganizationData,
  type UpdateOrganizationData,
  type AddMemberData,
} from './components/organization'

// Space Components
export {
  AgentListItem,
  type AgentListItemProps,
  type Space as SpaceUIType,
  type Space,
  type SpaceStatus,
} from './components/agent'

// Table Components
export {
  TableListItem,
  TableListItemCompact,
  CreateTableDialog,
  type TableListItemProps,
  type TableListItemCompactProps,
  type CreateTableDialogProps,
  type Table as TableUIType,
} from './components/table'

// Field Components
export {
  CreateFieldDialog,
  EditFieldDialog,
  ConversionPreviewDialog,
  SelectChoicesEditor,
  type CreateFieldDialogProps,
  type SelectChoicesEditorProps,
  type EditFieldDialogProps,
  type FieldOptions,
  type CreateFieldData,
  type EditFieldData,
  type ConversionPreviewDialogProps,
  type ConversionPreviewData,
  type ConversionResultStats,
} from './components/field'

// Record Components
export {
  RecordFormDialog,
  RecordHistoryDialog,
  RecordHistoryPanel,
  RecordHistorySheet,
  HistoryTimeline,
  groupOperations,
  groupByTimeSection,
  formatTimeRange,
  type RecordFormDialogProps,
  type RecordFormData,
  type FieldDefinition,
  type AttachmentFieldRenderProps,
  type AttachmentValue,
  type RecordHistoryDialogProps,
  type RecordHistoryPanelProps,
  type RecordHistorySheetProps,
  type HistoryTimelineProps,
  type HistoryOperation,
  type HistoryOperationUser,
  type FieldChange,
  type HistoryGroup,
  type NormalizedChange,
  type TimeSection,
} from './components/record'

// Comments Components
export {
  CommentsSection,
  type CommentItem,
  type CommentMentionCandidate,
  type CommentsLabels,
  type CommentsSectionProps,
} from './components/comments/CommentsSection'

// Field Value Editor (shared)
export {
  FieldValueEditor,
  type FieldValueEditorProps,
  type FieldValueEditorField,
  type AttachmentRenderProps,
  LinkRecordPicker,
  sliceDisplayColumns,
  resolveLinkPickerDialogSizeClass,
  LINK_PICKER_MIN_WIDTH_PX,
  LINK_PICKER_SIDE_GUTTER_PX,
  LINK_PICKER_OVERLAY_PASS_THROUGH_CLASS,
  type LinkRecordPickerProps,
  type LinkPickerRecord,
  type LinkPickerField,
  type LinkPickerListMode,
  LinkedRecordsTable,
  type LinkedRecordsTableProps,
  type LinkedRecordItem,
  type LinkedRecordColumn,
  formatLinkRecordLabel,
  isIdLikeLinkTitle,
  resolveLinkGridCellText,
  UNNAMED_RECORD_DISPLAY_NAME,
} from './components/field-editor'

// Import/Export Dialog
export {
  ExportDialog as DataExportDialog,
  type ExportDialogProps as DataExportDialogProps,
  type ExportFormat as DataExportFormat,
  type ExportRange as DataExportRange,
  type ExportConfig as DataExportConfig,
  type ExportStats as DataExportStats,
  type Field as DataExportField,
} from './components/export-dialog'

// Import Components
export {
  ImportDialog as DataImportDialog,
  FileUpload,
  PreviewMapping,
  ImportProgress,
  type ImportDialogProps as DataImportDialogProps,
  type ImportPreviewResponse as DataImportPreviewResponse,
  type ImportConfig as DataImportConfig,
  type FileUploadProps,
  type ImportTemplateFormat,
  type PreviewMappingProps,
  type ImportProgressProps,
  type ImportStatus as DataImportStatus,
  type ImportResult as DataImportResult,
  type Field as DataImportField,
  type FieldMapping as DataImportFieldMapping,
  type ValidationIssue as DataImportValidationIssue,
} from './components/import'

// Radio Group
export { RadioGroup, RadioGroupItem } from './components/radio-group'

// Switch
export { Switch } from './components/switch'

// Progress
export { Progress } from './components/progress'

// Tabs
export { TabsRoot, TabsList, TabsTrigger, TabsContent } from './components/tabs'

// Form Components
export { Textarea } from './components/textarea'
export { Checkbox } from './components/checkbox'
export { Form, FormField, FormLabel, FormMessage, FormDescription } from './components/form'
export { ScrollArea, ScrollBar } from './components/scroll-area'
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from './components/select'
export { ConfirmDialog } from './components/confirm-dialog'
export type { ConfirmDialogProps } from './components/confirm-dialog'
// 浮层统一玻璃材质常量（design-system §10.2 / §14 真源）：所有脱离布局流的浮层
// 统一附加此类名，不要逐组件各写 bg-popover / backdrop-blur-* / border / shadow-*。
export { OPAQUE_OVERLAY_SURFACE_CLASS, OVERLAY_SURFACE_CLASS } from './components/overlay-surface'
export { VisuallyHidden } from './components/visually-hidden'

// Message / Toast Components（正典：message；toast 为兼容别名）
export { MessageHost, Toaster } from './components/toast/toaster'
export {
  message,
  installMessageTransport,
  getMessageController,
  createLocalMessageTransport,
} from './components/toast/message-api'
export { toast, useToast } from './components/toast/use-toast'
export {
  Toast,
  ToastProvider,
  ToastViewport,
  ToastAction,
  ToastClose,
  ToastTitle,
  ToastDescription,
} from './components/toast/toast'
export type { ToastProps, ToastActionElement, ToastVariant } from './components/toast/toast'
export type { ToastFn } from './components/toast/use-toast'
export type { MessageApi, MessageHandle, MessageOpenOptions, MessageTransport } from './components/toast/message-api'
export type { MessageType, MessageItem, MessageActionModel } from './components/toast/message-controller'

// Popover Components
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverClose,
} from './components/popover'

// Command Components (cmdk)
export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  useCommandState,
} from './components/command'

// Sheet Components (side panel / drawer)
export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './components/sheet'

// ComboboxSelect (searchable dropdown)
export {
  ComboboxSelect,
  type ComboboxSelectProps,
  type ComboboxSelectOption,
} from './components/combobox-select'

// SortableRuleRow (draggable rule row shell)
export {
  SortableRuleRow,
  type SortableRuleRowProps,
} from './components/sortable-rule-row'

// ViewTypeIcon (view type icons: grid/kanban/calendar/gallery)
export {
  ViewTypeIcon,
  type ViewTypeIconProps,
} from './components/common/view-type-icon'

// useLoadingTimeout hook
export {
  useLoadingTimeout,
  type UseLoadingTimeoutOptions,
  type UseLoadingTimeoutReturn,
} from './hooks/useLoadingTimeout'

// useFieldConversion hook
export {
  useFieldConversion,
  type UseFieldConversionOptions,
  type UseFieldConversionReturn,
  type FieldConversionUpdatePayload,
} from './hooks/useFieldConversion'

// useFieldConfigForm hook（字段配置表单状态管理，平台无关）
export {
  useFieldConfigForm,
  getDuplicateFieldNameError,
  type FieldLike,
  type FieldType as FieldConfigFieldType,
  type FieldOptions as FieldConfigOptions,
  type FieldSettingFormState,
  type FieldSettingFormResult,
  type FieldNameConflictCheckOptions,
  type LinkRelationship,
  type LookupFilterConfig,
  type LookupFilterItem,
  type DatetimeDateFormat,
  type DatetimeTimeFormat,
} from './hooks/useFieldConfigForm'

// ── Common Components（跨模块通用组件，从 Table 模块提炼） ──
export {
  // 字段类型图标
  FieldTypeIcon,
  getFieldTypeIcon,
  type FieldTypeIconProps,
  type FieldIconType,
  // 用户头像
  UserAvatar,
  type UserAvatarProps,
  // 保存状态指示器
  SaveStateIndicator,
  type SaveStateIndicatorProps,
  type SaveState,
  // 面板布局
  PanelLayout,
  type PanelLayoutProps,
  // 模块工具栏
  ModuleToolbar,
  ToolbarSeparator,
  ToolbarButton,
  ToolbarGroup,
  type ModuleToolbarProps,
  type ToolbarButtonProps,
  // 空状态
  EmptyState,
  type EmptyStateProps,
  type EmptyStatePresetIcon,
  // 操作反馈
  StatusNotice,
  type StatusNoticeProps,
  type StatusNoticeTone,
  // 面板级加载态
  PanelLoadingState,
  type PanelLoadingStateProps,
  type PanelLoadingStateVariant,
  // 版本历史面板
  RevisionPanel,
  type RevisionPanelProps,
  type RevisionItem,
} from './components/common'

// Floating Panel (reusable sidebar pattern)
export {
  FloatingPanel,
  CapsuleButton,
  CapsuleLabel,
  type FloatingPanelProps,
  type FloatingPanelContent,
  type FloatingPanelTab,
  type CapsuleButtonProps,
  type CapsuleLabelProps,
} from './components/floating-panel'

// Utils
export { cn } from './utils/cn'

// Time Utils
export {
  formatSmartTime,
  formatDateTime,
  formatRelativeTime,
  isSameDay,
  isSameWeek,
} from './utils/time'

// Cell value formatting
export { formatCellValue, compactCellValue } from './utils/cell-value'

// Choice / Tag colors
export {
  CHOICE_COLOR_HEX_MAP,
  FALLBACK_TAG_BG_COLORS,
  FALLBACK_TAG_TEXT_COLORS,
  SELECT_CHOICE_PRESET_COLORS,
  stableHash,
  normalizeHexColor,
  normalizeSelectChoices,
  isLightHexColor,
  mixHexWithWhite,
  resolveChoiceTagColors,
  resolveSelectChipColors,
  type ChoiceColorOption,
  type SelectChoiceOption,
} from './utils/choice-colors'

// Types
export type { AgentCardProps } from './components/agent-card'
export type { TableInfo, TableSelectorProps } from './components/table-selector'
export type { LoadingSpinnerProps } from './components/loading-spinner'
export type { SkeletonProps } from './components/skeleton'
export type { InputProps } from './components/input'
export type { LabelProps } from './components/label'

// Sidebar Components
export { Sidebar, type SidebarProps } from './components/sidebar/sidebar'

// Tooltip Components
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  type TooltipContentProps,
} from './components/tooltip'

// Context Menu Components
export {
  ContextMenu,
  ContextMenuItem,
  ContextMenuDivider,
  ContextMenuSection,
  ContextMenuHeader,
  ContextMenuSubMenu,
  ContextMenuInput,
  ContextMenuTextarea,
  ContextMenuCheckbox,
  ContextMenuCustom,
  type ContextMenuProps,
  type ContextMenuItemProps,
  type ContextMenuSubMenuProps,
  type ContextMenuInputProps,
  type ContextMenuTextareaProps,
  type ContextMenuCheckboxProps,
  type ContextMenuSectionProps,
  type ContextMenuDividerProps,
  type ContextMenuHeaderProps,
  type ContextMenuCustomProps,
} from './components/context-menu'

// Panel Components (shared across design-engine, tabslide, etc.)
export {
  // Utilities
  rgbToHex, hexToRgb, rgbToHsv, hsvToRgb,
  rgbToHsl, hslToRgb, hexToHsv, hsvToHex,
  hexToHsl, hslToHex, isValidHex, normalizeHex as normalizeHexPanel,
  colorWithOpacity, CHECKERBOARD_BG,
  type RGB, type HSV, type HSL,
  // Section state
  getSectionStorage, readSectionCollapsed, writeSectionCollapsed,
  sectionStorageKey, type SectionStorage,
  // Gradient types
  type Gradient, type GradientStop, type GradientType, type HexColor,
  // Scheduler
  createInteractionUndoScheduler, type InteractionUndoScheduler,
  // Components — collapsible section
  SectionPanel, type SectionPanelProps,
  // Components — numeric input
  NumberInput, evaluateExpression, type NumberInputProps,
  // Components — color
  ColorPicker, type ColorPickerProps, type ColorPickerLabels,
  ColorSwatch, type ColorSwatchProps,
  GradientEditor, type GradientEditorProps, type GradientEditorLabels,
  // Components — panel primitives
  PanelSection, type PanelSectionProps,
  PanelDivider, type PanelDividerProps,
  PanelTitle, type PanelTitleProps,
  PanelFieldLabel, type PanelFieldLabelProps,
  PanelRow, type PanelRowProps,
  PanelIconButton, type PanelIconButtonProps,
  PanelButtonGroup, type PanelButtonGroupProps,
  PanelToggleButton, type PanelToggleButtonProps,
  // Components — panel form controls
  PanelInput, type PanelInputProps,
  PanelSelect, type PanelSelectProps,
  PanelTextarea, type PanelTextareaProps,
  // Components — range slider
  PanelRangeSlider, type PanelRangeSliderProps,
  PanelRangeField, type PanelRangeFieldProps,
  // Components — insert card
  InsertCardGrid, type InsertCardGridProps,
  InsertCard, type InsertCardProps,
  CategoryTitle, type CategoryTitleProps,
} from './components/panel'

// Date Components
export {
  CalendarMonth,
  type CalendarMonthProps,
  type RangeModifiers,
} from './components/date/CalendarMonth'
export {
  DatePicker,
  type DatePickerProps,
} from './components/date/DatePicker'
export {
  TimeSelect,
  type TimeSelectProps,
} from './components/date/TimeSelect'
export {
  DateRangePicker,
  type DateRangePickerProps,
} from './components/date/DateRangePicker'
export {
  useDateEditorCore,
  type UseDateEditorCoreOptions,
  type UseDateEditorCoreReturn,
} from './components/date/useDateEditorCore'
export {
  type DateFieldOptionsLike,
  type DateFormattingConfig,
  type DateRangeValue,
  type ResolvedDateFormatting,
  isDateOnlyValue,
  normalizeDateFormatting as normalizeDateFieldFormatting,
  parseStoredDateValue as parseDateStoredValue,
  formatStoredDateValue as formatDateStoredValue,
  toStoredDateValue as toDateStoredValue,
  formatTimeFromDate,
  applyTimeToDate,
  hasSecondsInTimeFormat,
  getTodayInTimeZone,
  getDatePickerLocale,
} from './components/date/utils'

// Filter Components
export {
  DateFilterPicker,
  type DateFilterPickerProps,
  type DateFilterValue as DateFilterPickerValue,
  type DateFilterMode as DateFilterPickerMode,
} from './components/filter/DateFilterPicker'

// User Components
export {
  UserSelector,
  UserInitialsAvatar,
  type UserSelectorProps,
  type UserOption,
} from './components/user'

// Field Config Components（字段配置子面板，从 Electron 提取）
export {
  AdvancedSettingsSection,
  DatetimeConfigSection,
  FieldTypeSelector,
  LinkConfigSection,
  type AdvancedSettingsSectionProps,
  type DatetimeConfigSectionProps,
  type FieldTypeSelectorProps,
  type LinkConfigSectionProps,
  type LinkableFieldItem,
  type LinkTableOption,
  type LinkForeignMeta,
  FieldConfigFormBody,
  type FieldConfigFormBodyProps,
} from './components/field-config'

// Error Boundary
export { PanelErrorBoundary, ModuleErrorBoundary, type ModuleCrashResult } from './components/error-boundary'

// ShareDialog（统一两段式分享对话框，TabDoc / TabData 共用）
export { resolvePublicAvatarUrl } from './share-dialog/resolvePublicAvatarUrl'
export {
  ShareDialog,
  CollaboratorsSection,
  PublicLinkSection,
  RemovedFromResourceOverlay,
  useCollaborators,
  useShareSettings,
  scopeToShareType,
  shareTypeToScope,
  useMemberSearch,
  useResourceShareDowngrade,
  resolveResourceShareDowngrade,
  isPermissionInsufficientForEditing,
  hasLiveResourceAccess,
  shouldShowRemovedOverlay,
  selectResourceShareNotifications,
  PERMISSION_LEVEL,
  type ShareDialogProps,
  type ResourceType as ShareResourceType,
  type CollaboratorPermission,
  type ShareLinkPermission,
  type ShareScope,
  type UserBrief as ShareUserBrief,
  type CollaboratorOut,
  type SkippedReason,
  type SkippedItem as ShareSkippedItem,
  type InviteResult as ShareInviteResult,
  type ShareSettings,
  type SearchedUser as ShareSearchedUser,
  type UseCollaboratorsResult,
  type UseShareSettingsResult,
  type EnableShareOptions,
  type UseMemberSearchResult,
  type RemovedFromResourceOverlayProps,
  type ResourceShareDowngradeState,
  type ResourceShareNotificationLike,
  type DowngradeAction,
} from './share-dialog'

// Field validation rules（与后端 validate_with_rules 对齐；格子 / 表单共用）
export {
  validateFieldRules,
  coerceRuleNumber,
  normalizeValidationPattern,
  type FieldRulesValidationResult,
} from './utils/fieldValidationRules'

// i18n
export { setSmartsheetUiLocale, setSmartsheetUiTranslator, getSmartsheetUiLocale, t as smartsheetUiT } from './i18n'
