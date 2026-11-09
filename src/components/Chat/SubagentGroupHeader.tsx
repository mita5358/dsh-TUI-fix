import React from 'react'
import { Box, Text, useAnimationFrame } from '../../ui.js'
import type { SubagentGroupRow } from '../../adapter/ports/channel-view.js'
import { formatDuration } from '../../trajectory/format.js'
import { t } from '../../i18n.js'
import { isMinimalUiMode } from '../../minimalUiMode.js'

/** One summary chip: the count text plus the color that carries its meaning. */
type Chip = { key: string; text: string; color: 'warning' | 'error' | 'success' | undefined }

/**
 * Header line of a consecutive-subagent group (`row.subagentGroup`): the run
 * summary while the group is open, and the fold line once it is closed.
 *
 *   ▾ 子代理 ×6 · 4 已完成 · 合计 1m32s
 *   ▸ 已折叠 6 个子代理 · 全部完成 · 合计 2m05s · 点击展开
 *
 * A fan-out of parallel workers is one unit of work: reading a dozen `⑂`
 * cards one by one tells you almost nothing the aggregate does not, and it
 * buries the conversation. The fold line keeps the header's row and glyph
 * slot so a settling group reads as the SAME block tucking its body away —
 * the thinking/compact fold convention — instead of a new row appearing.
 *
 * The line is clickable and brightens on hover (Ctrl+O expands every group at
 * once). Failures stay LOUD while folded: failed/cancelled workers paint in
 * the error color, because folding must never bury a subagent that died.
 */
export function SubagentGroupHeader({ group, onToggle }: {
  group: SubagentGroupRow
  onToggle?(): void
}): React.ReactNode {
  const minimalUi = isMinimalUiMode()
  const [hovered, setHovered] = React.useState(false)
  // Only a LIVE group ticks: a settled run's duration is frozen, so it must
  // not keep re-rendering the row.
  const [tickRef] = useAnimationFrame(group.live > 0 ? 1000 : null)
  const clickable = onToggle !== undefined
  const endedAt = group.endedAt ?? Date.now()
  const duration = formatDuration(Math.max(0, endedAt - group.startedAt))
  const chipColor = (color: Chip['color']): Chip['color'] => minimalUi ? undefined : color

  const chips: Chip[] = []
  if (group.live > 0) chips.push({ key: 'live', text: t('subagents-group-live', { count: group.live }), color: chipColor('warning') })
  if (group.failed > 0) chips.push({ key: 'failed', text: t('subagents-group-failed', { count: group.failed }), color: chipColor('error') })
  if (group.folded && group.live === 0 && group.failed === 0) {
    // Folded and clean: "全部完成" says more than "6 已完成" — the group is
    // the unit being reported on now.
    chips.push({ key: 'all', text: t('subagents-group-all-completed'), color: chipColor('success') })
  } else if (group.completed > 0) {
    chips.push({ key: 'completed', text: t('subagents-group-completed', { count: group.completed }), color: undefined })
  }

  // The mouse affordance: a folded line always teaches the way back in; an
  // open group only says it while hovered (its ▾ already carries the hint).
  const hint = group.folded
    ? t('subagents-group-hint-expand')
    : hovered && clickable ? t('subagents-group-hint-fold') : undefined

  return (
    <Box
      flexDirection="row"
      gap={1}
      ref={tickRef}
      onClick={clickable ? onToggle : undefined}
      onMouseEnter={clickable ? (): void => setHovered(true) : undefined}
      onMouseLeave={clickable ? (): void => setHovered(false) : undefined}
    >
      <Text color={hovered && clickable && !minimalUi ? 'accent' : 'inactive'}>
        {group.folded ? '▸' : '▾'}
      </Text>
      <Text
        wrap="truncate-end"
        color={hovered && clickable ? 'text' : undefined}
        dimColor={!(hovered && clickable)}
      >
        {group.folded
          ? t('subagents-group-folded', { count: group.count })
          : t('subagents-group-title', { count: group.count })}
      </Text>
      {chips.map(chip => (
        <React.Fragment key={chip.key}>
          <Text color="inactive">·</Text>
          <Text color={chip.color} dimColor={chip.color === undefined}>{chip.text}</Text>
        </React.Fragment>
      ))}
      <Text color="inactive">·</Text>
      <Text dimColor>{t('subagents-group-elapsed', { duration })}</Text>
      {hint !== undefined && (
        <React.Fragment>
          <Text color="inactive">·</Text>
          <Text color={group.folded ? 'inactive' : 'accent'}>{hint}</Text>
        </React.Fragment>
      )}
    </Box>
  )
}
