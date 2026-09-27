"use client";

import { useId, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import ProfilePostsGallery from "@/components/ProfilePostsGallery";
import OffersPanel from "@/components/OffersPanel";

type Props = {
  gallery: ComponentProps<typeof ProfilePostsGallery>;
  offers: ComponentProps<typeof OffersPanel>;
  postsError?: boolean;
  offersError?: boolean;
};

export default function ProfileContent({ gallery, offers, postsError, offersError }: Props) {
  const [active, setActive] = useState<"posts" | "offers">("posts");
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 :
      event.key === "ArrowRight" || event.key === "ArrowLeft" ? 1 - index : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next === 0 ? "posts" : "offers");
    tabs.current[next]?.focus();
  }
  return (
    <div className="mt-3 -mx-4 lg:mx-0" data-profile-content>
      <div role="tablist" aria-label="Profile content" className="flex">
        {(["posts", "offers"] as const).map((tab, index) => (
          <button key={tab} ref={el => { tabs.current[index] = el; }} type="button" role="tab"
            id={`${id}-${tab}-tab`} aria-controls={`${id}-${tab}-panel`} aria-selected={active === tab}
            tabIndex={active === tab ? 0 : -1} onClick={() => setActive(tab)} onKeyDown={event => navigate(event, index)}
            className={`flex-1 border-b-2 py-3 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${active === tab ? "border-white text-white" : "border-transparent text-white/60"}`}>
            {tab === "posts" ? "Posts" : "Offers"}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-posts-panel`} aria-labelledby={`${id}-posts-tab`} hidden={active !== "posts"} tabIndex={0}>
        {postsError ? <p role="alert" className="px-4 py-8 text-center text-white/60">Couldn&apos;t load posts. Refresh the page to try again.</p> :
          gallery.posts.length ? <ProfilePostsGallery {...gallery} /> : <p className="px-4 py-8 text-center text-white/60">No posts yet</p>}
      </div>
      <div role="tabpanel" id={`${id}-offers-panel`} aria-labelledby={`${id}-offers-tab`} hidden={active !== "offers"} tabIndex={0}>
        {offersError ? <p role="alert" className="px-4 py-8 text-center text-white/60">Couldn&apos;t load offers. Refresh the page to try again.</p> :
          offers.offers.length ? <OffersPanel {...offers} inline /> : <p className="px-4 py-8 text-center text-white/60">No offers yet</p>}
      </div>
    </div>
  );
}
