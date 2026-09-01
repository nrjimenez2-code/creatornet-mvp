import type { Metadata } from "next";

type Props = {
  params: Promise<{ hashtag: string }>;
  children: React.ReactNode;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { hashtag } = await params;
  let tag = "";
  try {
    tag = decodeURIComponent(hashtag ?? "").slice(0, 60);
  } catch {
    tag = (hashtag ?? "").slice(0, 60);
  }
  if (!tag) return { title: "Tags" };
  return {
    title: `#${tag}`,
    description: `Videos tagged #${tag} on CreatorNet.`,
  };
}

export default function TagLayout({ children }: Props) {
  return children;
}
