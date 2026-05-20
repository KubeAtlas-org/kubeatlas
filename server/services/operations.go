// ==========================================================================================
// Kubernetes resource operations — scale and restart
// ==========================================================================================

package services

import (
	"context"
	"errors"
	"time"

	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// ScaleResource sets the replica count for a Deployment, ReplicaSet, or StatefulSet
func (k *Kubernetes) ScaleResource(ns, kind, name string, replicas int32) error {
	ctx := context.TODO()
	apps := k.clientSet.AppsV1()

	switch kind {
	case "Deployment":
		scale, err := apps.Deployments(ns).GetScale(ctx, name, metaV1.GetOptions{})
		if err != nil {
			return err
		}

		scale.Spec.Replicas = replicas

		_, err = apps.Deployments(ns).UpdateScale(ctx, name, scale, metaV1.UpdateOptions{})

		return err

	case "ReplicaSet":
		scale, err := apps.ReplicaSets(ns).GetScale(ctx, name, metaV1.GetOptions{})
		if err != nil {
			return err
		}

		scale.Spec.Replicas = replicas

		_, err = apps.ReplicaSets(ns).UpdateScale(ctx, name, scale, metaV1.UpdateOptions{})

		return err

	case "StatefulSet":
		scale, err := apps.StatefulSets(ns).GetScale(ctx, name, metaV1.GetOptions{})
		if err != nil {
			return err
		}

		scale.Spec.Replicas = replicas

		_, err = apps.StatefulSets(ns).UpdateScale(ctx, name, scale, metaV1.UpdateOptions{})

		return err

	default:
		return errors.New("scaling not supported for kind: " + kind)
	}
}

// RestartResource triggers a rollout restart by patching the pod template annotation
func (k *Kubernetes) RestartResource(ns, kind, name string) error {
	gvr, err := k.kindToGVR(kind)
	if err != nil {
		return err
	}

	patch := []byte(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"` +
		time.Now().Format(time.RFC3339) + `"}}}}}`)

	_, err = k.client.Resource(gvr).Namespace(ns).Patch(
		context.TODO(), name, types.MergePatchType, patch, metaV1.PatchOptions{},
	)

	return err
}
