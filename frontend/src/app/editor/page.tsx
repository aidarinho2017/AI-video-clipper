import VideoEditor from "../../editor/VideoEditor";

export default async function EditorPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; clip?: string }>;
}) {
  const query = await searchParams;
  const clipIndex = query.clip ? Number(query.clip) : undefined;
  return <VideoEditor jobId={query.job} clipIndex={clipIndex} />;
}
