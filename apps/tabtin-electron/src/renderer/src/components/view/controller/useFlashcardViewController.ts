import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type {
  ViewMeta,
  ViewRecordsResponse,
  FlashcardViewConfig,
  Field,
  TableRecord,
} from '@tabtin/table-core'
import { RecordApiService } from '@tabtin/table-core'
import { useTableCollab } from '@components/table/TableCollabContext'

export interface UseFlashcardViewControllerInput {
  currentView: ViewMeta | undefined
  currentViewRecords: ViewRecordsResponse | null
  fields: Field[]
  refreshCurrentView: () => Promise<void>
  isReadonly?: boolean
}

export interface FlashcardViewControllerState {
  cards: TableRecord[]
  isReadonly: boolean
  currentIndex: number
  isFlipped: boolean
  totalCards: number
  masteredCount: number
  config: FlashcardViewConfig | null
  frontField: Field | undefined
  backField: Field | undefined
  masteryField: Field | undefined
  tagsField: Field | undefined
  getRecordFieldValue: (record: any, fieldIdOrName?: string) => unknown

  flipCard: () => void
  nextCard: () => void
  prevCard: () => void
  markMastered: () => Promise<void>
  markNotMastered: () => Promise<void>
  shuffleCards: () => void
  resetProgress: () => void
  goToCard: (index: number) => void
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function useFlashcardViewController(
  input: UseFlashcardViewControllerInput,
): FlashcardViewControllerState {
  const { currentView, currentViewRecords, fields, isReadonly = false } = input
  // ：协作在线时掌握度写 Y.Doc（他端实时可见）；否则保持现有 REST 行为。
  const { isCollabRuntime, updateRecordFields } = useTableCollab()

  const config = useMemo<FlashcardViewConfig | null>(() => {
    if (!currentView || currentView.view_type !== 'flashcard') return null
    const c = currentView.config as FlashcardViewConfig
    if (!c?.front_field || !c?.back_field) return null
    return c
  }, [currentView])

  const fieldIdToNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of fields) map.set(f.id, f.name)
    return map
  }, [fields])

  const fieldNameToIdMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of fields) map.set(f.name, f.id)
    return map
  }, [fields])

  const fieldMap = useMemo(() => {
    const map = new Map<string, Field>()
    for (const f of fields) map.set(f.id, f)
    return map
  }, [fields])

  const frontField = config ? fieldMap.get(config.front_field) : undefined
  const backField = config ? fieldMap.get(config.back_field) : undefined
  const masteryField = config?.mastery_field ? fieldMap.get(config.mastery_field) : undefined
  const tagsField = config?.tags_field ? fieldMap.get(config.tags_field) : undefined

  const getRecordFieldValue = useCallback(
    (record: any, fieldIdOrName?: string): unknown => {
      if (!fieldIdOrName) return undefined

      const fieldId = fieldIdToNameMap.has(fieldIdOrName)
        ? fieldIdOrName
        : fieldNameToIdMap.get(fieldIdOrName)
      const fieldName = (fieldId ? fieldIdToNameMap.get(fieldId) : undefined) ?? fieldIdOrName

      const recordFields =
        record && typeof record === 'object' && record.fields && typeof record.fields === 'object'
          ? (record.fields as Record<string, unknown>)
          : undefined

      return (
        (fieldId ? recordFields?.[fieldId] : undefined) ??
        recordFields?.[fieldIdOrName] ??
        recordFields?.[fieldName] ??
        undefined
      )
    },
    [fieldIdToNameMap, fieldNameToIdMap],
  )

  const allRecords = useMemo<TableRecord[]>(
    () => currentViewRecords?.records ?? [],
    [currentViewRecords],
  )

  const [cardOrder, setCardOrder] = useState<number[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isFlipped, setIsFlipped] = useState(false)
  const [localMastery, setLocalMastery] = useState<Map<string, boolean>>(new Map())
  const previousRecordIdsRef = useRef<string[]>([])

  useEffect(() => {
    const nextRecordIds = allRecords.map((record, index) =>
      String(record.id ?? (record as any).record_id ?? index)
    )
    const previousRecordIds = previousRecordIdsRef.current
    const isAppend =
      previousRecordIds.length > 0 &&
      nextRecordIds.length >= previousRecordIds.length &&
      previousRecordIds.every((id, index) => nextRecordIds[index] === id)
    const indices = allRecords.map((_, i) => i)
    previousRecordIdsRef.current = nextRecordIds

    setCardOrder(prev => {
      if (config?.auto_shuffle) {
        if (isAppend) {
          const known = new Set(prev)
          const appended = indices.filter(index => !known.has(index))
          return appended.length > 0 ? [...prev, ...shuffleArray(appended)] : prev
        }
        return shuffleArray(indices)
      }
      return indices
    })

    if (!isAppend) {
      setCurrentIndex(0)
      setIsFlipped(false)
      setLocalMastery(new Map())
    }
  }, [allRecords, config?.auto_shuffle])

  const cards = useMemo(
    () => cardOrder.map(i => allRecords[i]).filter(Boolean),
    [cardOrder, allRecords],
  )

  const isMastered = useCallback(
    (record: TableRecord): boolean => {
      const recordId = record.id ?? (record as any).record_id
      if (!recordId) return false
      if (localMastery.has(recordId)) return localMastery.get(recordId)!
      if (!masteryField) return false
      const raw = getRecordFieldValue(record, masteryField.id)
      return raw === true || raw === 'true' || raw === 1
    },
    [masteryField, localMastery, getRecordFieldValue],
  )

  const masteredCount = useMemo(
    () => cards.filter(c => isMastered(c)).length,
    [cards, isMastered],
  )

  const flipCard = useCallback(() => setIsFlipped(v => !v), [])

  const nextCard = useCallback(() => {
    setIsFlipped(false)
    setCurrentIndex(i => Math.min(i + 1, cards.length - 1))
  }, [cards.length])

  const prevCard = useCallback(() => {
    setIsFlipped(false)
    setCurrentIndex(i => Math.max(i - 1, 0))
  }, [])

  const goToCard = useCallback(
    (index: number) => {
      setIsFlipped(false)
      setCurrentIndex(Math.max(0, Math.min(index, cards.length - 1)))
    },
    [cards.length],
  )

  const cardsRef = useRef(cards)
  cardsRef.current = cards

  const updateMastery = useCallback(
    async (mastered: boolean) => {
      const card = cardsRef.current[currentIndex]
      if (!card) return
      if (isReadonly) return
      const recordId = card.id ?? (card as any).record_id
      if (!recordId) return
      setLocalMastery(prev => new Map(prev).set(recordId, mastered))

      if (masteryField) {
        try {
          if (isCollabRuntime) {
            await updateRecordFields(recordId, { [masteryField.name]: mastered })
          } else {
            await RecordApiService.updateRecord(recordId, {
              fields: { [masteryField.name]: mastered },
            })
          }
        } catch {
          // optimistic update stays
        }
      }
    },
    [currentIndex, isReadonly, masteryField, isCollabRuntime, updateRecordFields],
  )

  const markMastered = useCallback(async () => {
    await updateMastery(true)
    setIsFlipped(false)
    setCurrentIndex(i => {
      const len = cardsRef.current.length
      return i < len - 1 ? i + 1 : i
    })
  }, [updateMastery])

  const markNotMastered = useCallback(async () => {
    await updateMastery(false)
    setIsFlipped(false)
    setCurrentIndex(i => {
      const len = cardsRef.current.length
      return i < len - 1 ? i + 1 : i
    })
  }, [updateMastery])

  const shuffleCards = useCallback(() => {
    setCardOrder(prev => shuffleArray(prev))
    setCurrentIndex(0)
    setIsFlipped(false)
  }, [])

  const resetProgress = useCallback(() => {
    setLocalMastery(new Map())
    setCurrentIndex(0)
    setIsFlipped(false)
  }, [])

  return {
    cards,
    isReadonly,
    currentIndex,
    isFlipped,
    totalCards: cards.length,
    masteredCount,
    config,
    frontField,
    backField,
    masteryField,
    tagsField,
    getRecordFieldValue,
    flipCard,
    nextCard,
    prevCard,
    markMastered,
    markNotMastered,
    shuffleCards,
    resetProgress,
    goToCard,
  }
}
