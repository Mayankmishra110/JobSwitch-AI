'use client';

import { useActionState } from 'react';
import type { CandidateProfile, ProfileSkill } from '@jobswitch/core';
import { updateProfile, replaceSkills } from './actions';

const initial = { error: null as string | null };

export function ProfileForm({ profile, skills }: { profile: CandidateProfile | null; skills: ProfileSkill[] }) {
  const [profileState, profileAction, profilePending] = useActionState(updateProfile, initial);
  const [skillsState, skillsAction, skillsPending] = useActionState(replaceSkills, initial);

  return (
    <>
      <form action={profileAction} className="card">
        <h3 style={{ marginTop: 0 }}>About you</h3>
        <label>
          Headline
          <input name="headline" defaultValue={profile?.headline ?? ''} placeholder="Senior Backend Engineer" />
        </label>
        <label>
          Current title
          <input name="currentTitle" defaultValue={profile?.currentTitle ?? ''} />
        </label>
        <label>
          Desired titles (comma-separated)
          <input name="desiredTitles" defaultValue={profile?.desiredTitles.join(', ') ?? ''} />
        </label>
        <label>
          Desired locations (comma-separated)
          <input name="desiredLocations" defaultValue={profile?.desiredLocations.join(', ') ?? ''} />
        </label>
        {profileState.error && <p className="form-error">{profileState.error}</p>}
        <button type="submit" className="btn btn-primary" disabled={profilePending}>
          {profilePending ? 'Saving…' : 'Save'}
        </button>
      </form>

      <form action={skillsAction} className="card">
        <h3 style={{ marginTop: 0 }}>Skills</h3>
        <label>
          Comma-separated
          <input name="skills" defaultValue={skills.map((s) => s.skill).join(', ')} />
        </label>
        {skillsState.error && <p className="form-error">{skillsState.error}</p>}
        <button type="submit" className="btn btn-primary" disabled={skillsPending}>
          {skillsPending ? 'Saving…' : 'Save skills'}
        </button>
      </form>
    </>
  );
}
