import { WorkspaceSection } from "../../../../components/workspace-section";
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return <WorkspaceSection sectionKey={section} />;
}
