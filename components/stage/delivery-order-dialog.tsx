'use client';

/**
 * The one thing to check before a delivery-pack export.
 *
 * A pack holds the deck, the script, the subtitles and the booklet — but not
 * the video and not the single-file HTML: those are separate exports, because
 * the MP4 is uploaded server-side by the render worker and the HTML is a
 * different artifact, not a part of the pack.
 *
 * All three kinds write into the folder of the *current* version, and only the
 * pack advances that number (§ `advanceDeliveryRevision`). Export the pack
 * first and the video and the HTML that follow land in `v(n+1)` — one handover
 * split across two sibling folders, which is exactly what the version scheme
 * exists to prevent.
 *
 * The order cannot be enforced in code without a "delivery round" the app does
 * not model, so it is stated once, with the concrete round it is about to
 * write, and the operator decides whether to go ahead.
 *
 * The competition tier needs a different sentence, because its first step does
 * not exist: it sells no video at all. Telling that operator to "render first"
 * would send them looking for a render they must not attach.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { DeliverySku } from '@/lib/export/delivery-bundle';
import { useI18n } from '@/lib/hooks/use-i18n';

interface DeliveryOrderDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Runs only after the operator accepted the order; the export itself. */
  readonly onConfirm: () => void;
  /** Round the pack will be written into, shown as `v<n>/`. */
  readonly revision: number;
  /** Which tier this round is for; decides whether a video is expected. */
  readonly sku: DeliverySku;
}

export function DeliveryOrderDialog({
  open,
  onOpenChange,
  onConfirm,
  revision,
  sku,
}: DeliveryOrderDialogProps) {
  const { t } = useI18n();
  const wantsVideo = sku === 'lesson';

  // The deliverables of one handover, in the order that keeps them in the same
  // folder. Reuses the menu's own labels so the list reads as the steps the
  // operator just saw — minus the video, on the tier that ships without one.
  const steps = [
    ...(wantsVideo ? [t('export.video')] : []),
    t('export.html'),
    t(wantsVideo ? 'export.bundle.lessonLabel' : 'export.bundle.contestLabel'),
  ];

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(wantsVideo ? 'export.bundle.confirmTitle' : 'export.bundle.confirmTitleContest')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(wantsVideo ? 'export.bundle.confirmDesc' : 'export.bundle.confirmDescContest')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ol className="space-y-1.5 text-sm">
          {steps.map((label, index) => (
            <li key={label} className="flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {index + 1}
              </span>
              <span
                className={
                  index === steps.length - 1 ? 'font-medium text-gray-900 dark:text-gray-100' : ''
                }
              >
                {label}
              </span>
            </li>
          ))}
        </ol>
        <p className="rounded-md bg-gray-50 px-3 py-2 font-mono text-xs text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">
          {t('export.bundle.confirmTarget', { path: `v${revision}/` })}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('export.bundle.confirmCancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('export.bundle.confirmOk')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
