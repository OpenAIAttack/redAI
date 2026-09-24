import type { ReactNode } from 'react';
import { ProjectNav } from '../../../../../components/ProjectNav';

/** Detail layout: project sub-nav above overview / files / settings. */
export default async function ProjectDetailLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}): Promise<JSX.Element> {
  const { projectId } = await params;
  return (
    <>
      <ProjectNav projectId={projectId} />
      {children}
    </>
  );
}
