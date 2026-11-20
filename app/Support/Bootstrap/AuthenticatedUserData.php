<?php

namespace App\Support\Bootstrap;

use App\Models\User;

class AuthenticatedUserData
{
    public function from(User $user): array
    {
        $userData = [
            'id' => $user->id,
            'name' => $user->name,
            'avatar_url' => $user->avatar_url,
            'cover_url' => $user->cover_url,
            'first_name' => $user->first_name,
            'last_name' => $user->last_name,
            'caption' => $user->getCaption(),
            'username' => $user->username,
            'has_tips' => $user->has_tips,
            'tips' => $user->tips,
            'is_master_account' => $user->isMasterAccount(),
            'is_author' => $user->isAuthor(),
            'verification' => [
                'status' => $user->verified,
                'date' => $user->verified_at ? $user->verified_at->getIso() : null,
            ],
            'meta' => [
                'is_admin' => $user->isAdmin(),
                'is_root' => $user->isRoot(),
            ],
        ];

        if($user->isAdmin() || $user->isRoot()) {
            $userData['meta']['admin'] = [
                'url' => route('admin.dash.index'),
            ];
        }

        return $userData;
    }
}
