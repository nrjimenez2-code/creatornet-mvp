import { LoadingLabel, Skeleton } from "./loading/Skeletons";
import styles from "./videoInsights.module.css";

export default function VideoInsightsSkeleton() {
  return <div className={styles.panel} aria-busy="true" data-insights-skeleton="true">
    <LoadingLabel>Loading video insights…</LoadingLabel>
    <div aria-hidden="true">
      <div className={styles.videoHeading}>
        <Skeleton className={styles.skeletonPoster} />
        <div className={`${styles.videoHeadingText} ${styles.skeletonVideoText}`}>
          <Skeleton className={styles.skeletonTitle} />
          <Skeleton className={styles.skeletonMeta} />
        </div>
      </div>

      <div className={styles.summary}>
        {Array.from({ length: 3 }, (_, index) => <div key={index}>
          <Skeleton className={styles.skeletonStatLabel} />
          <Skeleton className={styles.skeletonStatValue} />
        </div>)}
      </div>

      <div className={styles.retention}>
        <div className={styles.sectionHead}>
          <Skeleton className={styles.skeletonSectionTitle} />
          <Skeleton className={styles.skeletonSectionCount} />
        </div>
        <Skeleton className={styles.skeletonDescription} />
        <div className={styles.chart}><Skeleton className={styles.skeletonChart} /></div>
        <div className={styles.moment}>
          <div className={styles.momentControls}>
            <div className={styles.momentHeading}>
              <Skeleton className={styles.skeletonMomentLabel} />
              <Skeleton className={styles.skeletonMomentTime} />
            </div>
            <div className={styles.skeletonSliderHit}><Skeleton className={styles.skeletonSliderTrack} /></div>
            <div className={styles.momentFooter}>
              <Skeleton className={styles.skeletonMomentPercent} />
              <Skeleton className={styles.skeletonMomentEnd} />
            </div>
          </div>
          <Skeleton className={styles.skeletonPreview} />
        </div>
      </div>

      {Array.from({ length: 3 }, (_, index) => <div className={styles.disclosure} key={index}>
        <div className={styles.skeletonDisclosureRow}>
          <Skeleton className={styles.skeletonDisclosureTitle} />
          <Skeleton className={styles.skeletonDisclosureHint} />
        </div>
      </div>)}
      <Skeleton className={styles.skeletonFoot} />
    </div>
  </div>;
}
