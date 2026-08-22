from apps.tabtinspace.models import Collection, SharedResourcePlacement
from apps.tabtinspace.services.base import BaseService, ServiceError
from apps.tabtinspace.services.cloud_resource_acl import (
    resolve_tabdata_role,
    resolve_tabdoc_role,
    resolve_tabfiles_role,
)


class SharedResourcePlacementService(BaseService):
    ROLE_RESOLVERS = {
        'doc': resolve_tabdoc_role,
        'table': resolve_tabdata_role,
        'file': resolve_tabfiles_role,
    }

    def list(self, organization_id):
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('PERMISSION_DENIED', '无权访问该组织', status=403)
        return list(
            SharedResourcePlacement.objects.filter(
                organization_id=organization_id,
                user=self.user,
            ).values('resource_type', 'resource_id', 'collection_id', 'dismissed')
        )

    def move(self, organization_id, resource_type, resource_id, collection_id):
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('PERMISSION_DENIED', '无权访问该组织', status=403)

        resolver = self.ROLE_RESOLVERS.get(resource_type)
        role = resolver(self.user, str(resource_id)) if resolver else None
        if not role or role == 'owner':
            raise ServiceError('SHARED_RESOURCE_NOT_FOUND', '分享资源不存在或已失效', status=404)

        collection = None
        if collection_id:
            # placement 属于接收者本人，目标文件夹可以是组织中任意可见文件夹；
            # 不会修改文件夹所有者或原资源的归属。
            collection = Collection.objects.filter(
                id=collection_id,
                organization_id=organization_id,
            ).first()
            if collection is None:
                raise ServiceError('COLLECTION_NOT_FOUND', '目标文件夹不存在', status=404)

        placement, _ = SharedResourcePlacement.objects.update_or_create(
            organization_id=organization_id,
            user=self.user,
            resource_type=resource_type,
            resource_id=str(resource_id),
            defaults={'collection': collection, 'dismissed': False},
        )
        return placement

    def dismiss(self, organization_id, resource_type, resource_id):
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('PERMISSION_DENIED', '无权访问该组织', status=403)
        resolver = self.ROLE_RESOLVERS.get(resource_type)
        role = resolver(self.user, str(resource_id)) if resolver else None
        if not role or role == 'owner':
            raise ServiceError('SHARED_RESOURCE_NOT_FOUND', '分享资源不存在或已失效', status=404)
        placement, _ = SharedResourcePlacement.objects.update_or_create(
            organization_id=organization_id,
            user=self.user,
            resource_type=resource_type,
            resource_id=str(resource_id),
            defaults={'collection': None, 'dismissed': True},
        )
        return placement
