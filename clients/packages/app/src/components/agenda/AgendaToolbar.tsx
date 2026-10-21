import { useCommaMessages } from "@comma/i18n/react";
import {
  Button,
  ButtonGroup,
  ChevronLeftSmallIcon,
  ChevronRightSmallIcon,
  MinusIcon,
  PanelLeftIcon,
  PlusIcon,
  Tooltip,
} from "@comma/ui";
import type { AgendaView } from "./agendaDates";
import { agendaZoomMax, agendaZoomMin, agendaZoomStep } from "./agendaLayout";

export function AgendaToolbar({
  view,
  rangeLabel,
  zoom,
  panelOpen,
  onZoom,
  onTogglePanel,
  onView,
  onStep,
  onToday,
}: {
  view: AgendaView;
  rangeLabel: string;
  zoom: number;
  panelOpen: boolean;
  onZoom: (zoom: number) => void;
  onTogglePanel: () => void;
  onView: (view: AgendaView) => void;
  onStep: (direction: 1 | -1) => void;
  onToday: () => void;
}) {
  const m = useCommaMessages();
  const viewLabel = {
    "3days": m.agenda_view_3days(),
    week: m.agenda_view_week(),
    month: m.agenda_view_month(),
  }[view];
  const zoomable = view !== "month";

  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-md px-xl pt-xl pb-lg">
      <h1 className="m-0 flex min-w-0 items-baseline gap-md text-xl font-semibold text-primary">
        <span>{viewLabel}</span>
        <span
          className="truncate text-md font-normal text-tertiary"
          data-testid="agenda-range"
        >
          {rangeLabel}
        </span>
      </h1>
      <div className="flex flex-wrap items-center gap-md">
        {zoomable && (
          <fieldset className="m-0 inline-flex min-w-0 items-center rounded-md border border-primary p-0 shadow-xs">
            <Button
              aria-label={m.agenda_zoom_out()}
              hierarchy="tertiary-gray"
              iconLeading={<MinusIcon />}
              iconOnly
              isDisabled={zoom <= agendaZoomMin}
              onPress={() => onZoom(zoom - agendaZoomStep)}
              size="sm"
            />
            <Tooltip content={m.agenda_zoom_reset()}>
              <Button
                aria-label={m.agenda_zoom_reset()}
                className="min-w-14 tabular-nums"
                hierarchy="tertiary-gray"
                onPress={() => onZoom(100)}
                size="sm"
              >
                {`${zoom}%`}
              </Button>
            </Tooltip>
            <Button
              aria-label={m.agenda_zoom_in()}
              hierarchy="tertiary-gray"
              iconLeading={<PlusIcon />}
              iconOnly
              isDisabled={zoom >= agendaZoomMax}
              onPress={() => onZoom(zoom + agendaZoomStep)}
              size="sm"
            />
          </fieldset>
        )}
        <Tooltip content={m.agenda_panel_toggle()}>
          <Button
            aria-label={m.agenda_panel_toggle()}
            aria-pressed={panelOpen}
            hierarchy="tertiary-gray"
            iconLeading={<PanelLeftIcon />}
            iconOnly
            onPress={onTogglePanel}
            size="sm"
          />
        </Tooltip>
        <div aria-label={m.agenda_views()}>
          <ButtonGroup
            className="[&>button]:min-h-9 [&>button]:px-3"
            items={[
              { id: "3days", label: m.agenda_view_3days() },
              { id: "week", label: m.agenda_view_week() },
              { id: "month", label: m.agenda_view_month() },
            ]}
            onChange={(id) => onView(id as AgendaView)}
            value={view}
          />
        </div>
        <div className="inline-flex items-center gap-xs">
          <Button
            aria-label={m.agenda_previous()}
            hierarchy="secondary-gray"
            iconLeading={<ChevronLeftSmallIcon />}
            iconOnly
            onPress={() => onStep(-1)}
            size="sm"
          />
          <Button hierarchy="secondary-gray" onPress={onToday} size="sm">
            {m.agenda_today()}
          </Button>
          <Button
            aria-label={m.agenda_next()}
            hierarchy="secondary-gray"
            iconLeading={<ChevronRightSmallIcon />}
            iconOnly
            onPress={() => onStep(1)}
            size="sm"
          />
        </div>
      </div>
    </header>
  );
}
