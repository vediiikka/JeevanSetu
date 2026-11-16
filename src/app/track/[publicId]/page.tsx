import TrackView from "@/components/TrackView";

export const dynamic = "force-dynamic";

export default async function TrackPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <TrackView publicId={publicId} />;
}
