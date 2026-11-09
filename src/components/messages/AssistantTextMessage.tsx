import React from 'react'
import { Box, NoSelect, Text } from '../../ui.js'
import { BLACK_CIRCLE } from '../../terminal-utils/figures.js'
import { Markdown } from '../Markdown.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

type Props = {
  text: string
  /** Adds the top margin between messages. */
  marginTopOnTurn: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background). */
  isExpanded?: boolean
  /** Fold fenced code to one-row digests (settled historical rows). */
  foldedCode?: boolean
  expandedCodePaths?: ReadonlySet<string>
  closedGlobalCodePaths?: ReadonlySet<string>
  onToggleCodePath?: (path: string, event: ClickEvent) => void
}

/**
 * Assistant text message: bullet + markdown body.
 *
 * Deliberately not clickable: the transcript is reading material and the
 * mouse's job there is text selection (user feedback — row hover tints and
 * fold toggling were noise, not affordance).
 */
export function AssistantTextMessage({
  text,
  marginTopOnTurn,
  isSelected = false,
  isExpanded = false,
  foldedCode = false,
  expandedCodePaths,
  closedGlobalCodePaths,
  onToggleCodePath,
}: Props): React.ReactNode {
  return (
    <Box
      alignItems="flex-start"
      flexDirection="row"
      justifyContent="space-between"
      marginTop={marginTopOnTurn ? 1 : 0}
      width="100%"
      backgroundColor={
        isSelected
          ? 'messageActionsBackground'
          : isExpanded
            ? 'userMessageBackgroundHover'
            : undefined
      }
    >
      <Box flexDirection="row">
        <NoSelect fromLeftEdge minWidth={2}>
          <Text color={isSelected ? 'suggestion' : 'text'}>{BLACK_CIRCLE}</Text>
        </NoSelect>
        <Box flexDirection="column">
          <Markdown foldedCode={foldedCode} expandedCodePaths={expandedCodePaths} closedGlobalCodePaths={closedGlobalCodePaths} onToggleCodePath={onToggleCodePath}>{text}</Markdown>
        </Box>
      </Box>
    </Box>
  )
}
