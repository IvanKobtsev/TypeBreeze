package dev.typebreeze.webstorm

import com.intellij.codeInsight.daemon.GutterIconNavigationHandler
import com.intellij.codeInsight.daemon.LineMarkerInfo
import com.intellij.codeInsight.daemon.LineMarkerProvider
import com.intellij.icons.AllIcons
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.psi.PsiElement

class MappingLineMarkerProvider:LineMarkerProvider {
    override fun getLineMarkerInfo(element:PsiElement):LineMarkerInfo<*>? {
        val file=element.containingFile?.virtualFile?:return null
        if(!TypeBreezeLspProvider.supports(file))return null
        val cache=element.project.getService(MappingOccurrenceCache::class.java)
        val occurrence=cache.matching(file,element)?:return null
        val connector=occurrence.kind=="connector"
        val tooltip=buildString { append(if(connector)"Auto-mapping connector for " else "Mapped component in ");append(occurrence.mappingName);occurrence.reason?.let{append(" — ");append(it)} }
        val icon=if(connector)AllIcons.Nodes.Type else AllIcons.Nodes.Function
        return LineMarkerInfo(element,element.textRange,icon,{tooltip},GutterIconNavigationHandler{_,_->element.project.getService(MappingOccurrenceCache::class.java).navigate(file,occurrence)},GutterIconRenderer.Alignment.LEFT){tooltip}
    }
}
